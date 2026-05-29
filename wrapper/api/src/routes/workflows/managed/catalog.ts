import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  loadProjectAndAttachedDataFromString,
  serializeProject,
  type AttachedData,
  type Project,
} from '@valerypopoff/rivet2-node';

import type {
  WorkflowFolderItem,
  WorkflowProjectDownloadVersion,
  WorkflowProjectItem,
  WorkflowProjectPathMove,
  WorkflowProjectStats,
} from '../../../../../shared/workflow-types.js';
import { WORKFLOW_PROJECT_EXTENSION } from '../../../../../shared/workflow-types.js';
import { badRequest, conflict, createHttpError } from '../../../utils/httpError.js';
import { createBlankProjectFile, sanitizeWorkflowName } from '../fs-helpers.js';
import { getWorkflowProjectStatsFromContents } from '../project-stats.js';
import { getWorkflowDownloadFileName, getWorkflowDuplicateProjectName } from '../workflow-project-naming.js';
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
import type {
  FolderMoveRow,
  FolderRow,
  RecordingRow,
  RevisionRow,
  SaveHostedProjectResult,
  TransactionHooks,
  WorkflowRow,
} from './types.js';

type ManagedWorkflowCatalogServiceDependencies = {
  context: ManagedWorkflowContext;
  saveHostedProject(options: {
    projectPath: string;
    contents: string;
    datasetsContents: string | null;
    expectedRevisionId?: string | null;
  }): Promise<SaveHostedProjectResult>;
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
    readRevisionContents: options.context.revisions.readRevisionContents,
    assertFolderExists: options.context.queries.assertFolderExists,
    saveHostedProject: options.saveHostedProject,
    mapWorkflowRowToProjectItem: options.context.mappers.mapWorkflowRowToProjectItem,
    mapFolderRowToFolderItem: options.context.mappers.mapFolderRowToFolderItem,
    getWorkflowStatus: options.context.mappers.getWorkflowStatus,
    blobStore: options.context.blobStore,
    queueWorkflowInvalidation: options.context.executionInvalidationController.queueWorkflowInvalidation.bind(options.context.executionInvalidationController),
    queueGlobalInvalidation: options.context.executionInvalidationController.queueGlobalInvalidation.bind(options.context.executionInvalidationController),
    deleteBlobKeysBestEffort: options.context.revisions.deleteBlobKeysBestEffort,
    isUniqueViolation: options.context.db.isUniqueViolation,
    recordingColumns: options.context.mappers.RECORDING_COLUMNS,
    getWorkflowProjectStatsFromContents,
  };
  const emptyProjectStats = {
    graphCount: 0,
    totalNodeCount: 0,
  } as const;

  const moveFolderRelativePath = async (
    sourceRelativePath: string,
    targetRelativePath: string,
  ): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> => {
    try {
      return await deps.withTransaction(async (client, hooks) => {
        const temporaryPrefix = `.__move__-${randomUUID()}`;
        const folderName = path.posix.basename(targetRelativePath);
        const folderRow = await deps.queryOne<FolderMoveRow>(
          client,
          `
            SELECT relative_path, name, parent_relative_path, updated_at, moved_relative_paths
            FROM move_managed_workflow_folder($1, $2, $3, $4)
          `,
          [
            sourceRelativePath,
            temporaryPrefix,
            targetRelativePath,
            folderName,
          ],
        );

        if (!folderRow) {
          throw createHttpError(500, 'Moved folder could not be loaded');
        }

        const movedProjectPaths = (folderRow.moved_relative_paths ?? []).map((relativePath) => ({
          fromAbsolutePath: getManagedWorkflowProjectVirtualPath(relativePath),
          toAbsolutePath: getManagedWorkflowProjectVirtualPath(
            `${targetRelativePath}${relativePath.slice(sourceRelativePath.length)}`,
          ),
        }));

        if (movedProjectPaths.length > 0) {
          await deps.queueGlobalInvalidation(client, hooks);
        }

        return {
          folder: deps.mapFolderRowToFolderItem(folderRow),
          movedProjectPaths,
        };
      });
    } catch (error) {
      if (typeof error === 'object' && error != null && 'code' in error && String((error as { code?: unknown }).code ?? '') === 'P0002') {
        throw createHttpError(404, 'Folder not found');
      }

      if (deps.isUniqueViolation(error)) {
        throw conflict(`Folder already exists: ${path.posix.basename(targetRelativePath)}`);
      }

      throw error;
    }
  };

  const getRevisionStats = async (revision: RevisionRow): Promise<WorkflowProjectStats> => {
    if (revision.stats_graph_count != null && revision.stats_total_node_count != null) {
      return {
        graphCount: revision.stats_graph_count,
        totalNodeCount: revision.stats_total_node_count,
      };
    }

    try {
      const stats = deps.getWorkflowProjectStatsFromContents(await deps.readRevisionProjectContents(revision));
      await deps.queryRows(
        deps.pool,
        `
          UPDATE workflow_revisions
          SET stats_graph_count = $2,
              stats_total_node_count = $3
          WHERE revision_id = $1
            AND (stats_graph_count IS NULL OR stats_total_node_count IS NULL)
        `,
        [revision.revision_id, stats.graphCount, stats.totalNodeCount],
      ).catch(() => {});

      return stats;
    } catch {
      return emptyProjectStats;
    }
  };

  const moveWorkflowProjectRelativePath = async (
    sourceRelativePath: string,
    targetRelativePath: string,
  ): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> => {
    if (sourceRelativePath === targetRelativePath) {
      const workflow = await deps.getWorkflowByRelativePath(deps.pool, sourceRelativePath);
      if (!workflow) {
        throw createHttpError(404, 'Project not found');
      }

      return {
        project: deps.mapWorkflowRowToProjectItem(workflow),
        movedProjectPaths: [],
      };
    }

    return deps.withTransaction(async (client, hooks) => {
      const workflow = await deps.getWorkflowByRelativePath(client, sourceRelativePath, { forUpdate: true });
      if (!workflow) {
        throw createHttpError(404, 'Project not found');
      }

      if (await deps.getWorkflowByRelativePath(client, targetRelativePath)) {
        throw conflict(`Project already exists: ${path.posix.basename(targetRelativePath)}`);
      }

      const folderRelativePath = path.posix.dirname(targetRelativePath) === '.' ? '' : path.posix.dirname(targetRelativePath);
      await deps.assertFolderExists(client, folderRelativePath);

      const projectName = path.posix.basename(targetRelativePath, WORKFLOW_PROJECT_EXTENSION);
      await client.query(
        `
          UPDATE workflows
          SET name = $2,
              file_name = $3,
              relative_path = $4,
              folder_relative_path = $5,
              updated_at = NOW()
          WHERE workflow_id = $1
        `,
        [workflow.workflow_id, projectName, `${projectName}${WORKFLOW_PROJECT_EXTENSION}`, targetRelativePath, folderRelativePath],
      );

      const movedWorkflow = await deps.getWorkflowByRelativePath(client, targetRelativePath, { forUpdate: true });
      if (!movedWorkflow) {
        throw createHttpError(500, 'Moved project could not be loaded');
      }

      await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);

      return {
        project: deps.mapWorkflowRowToProjectItem(movedWorkflow),
        movedProjectPaths: [{
          fromAbsolutePath: getManagedWorkflowProjectVirtualPath(sourceRelativePath),
          toAbsolutePath: getManagedWorkflowProjectVirtualPath(targetRelativePath),
        }],
      };
    });
  };

  return {
    async getTree(): Promise<{ root: string; folders: WorkflowFolderItem[]; projects: WorkflowProjectItem[] }> {
      await deps.initialize();
      const [folderRows, workflowRows] = await Promise.all([
        deps.listFolderRows(),
        deps.listWorkflowRows(),
      ]);

      const folderMap = new Map<string, WorkflowFolderItem>();
      for (const row of folderRows) {
        folderMap.set(row.relative_path, deps.mapFolderRowToFolderItem(row));
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

      const workflowProjects = await Promise.all(workflowRows.map(async (row) => {
        const project = deps.mapWorkflowRowToProjectItem(row);
        const revision = await deps.getRevision(deps.pool, row.current_draft_revision_id);
        if (!revision) {
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
            stats: await getRevisionStats(revision),
          },
        };
      }));

      for (const { row, project } of workflowProjects) {
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
      const workflows = await deps.listWorkflowRows();
      return workflows.map((workflow) => getManagedWorkflowProjectVirtualPath(workflow.relative_path));
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

      const project = await deps.getCurrentDraftWorkflowRevision(deps.pool, parseManagedWorkflowProjectVirtualPath(filePath));
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

    async createWorkflowFolderItem(name: unknown, parentRelativePath: unknown) {
      const folderName = sanitizeWorkflowName(name, 'folder name');
      const parentPath = normalizeManagedWorkflowRelativePath(parentRelativePath, { allowProjectFile: false, allowEmpty: true });
      const folderRelativePath = parentPath ? `${parentPath}/${folderName}` : folderName;

      return deps.withTransaction(async (client) => {
        if (await deps.queryOne(client, 'SELECT relative_path FROM workflow_folders WHERE relative_path = $1', [folderRelativePath])) {
          throw conflict(`Folder already exists: ${folderName}`);
        }

        await deps.assertFolderExists(client, parentPath);
        await client.query(
          `
            INSERT INTO workflow_folders (relative_path, name, parent_relative_path, updated_at)
            VALUES ($1, $2, $3, NOW())
          `,
          [folderRelativePath, folderName, parentPath],
        );

        return deps.mapFolderRowToFolderItem({
          relative_path: folderRelativePath,
          name: folderName,
          parent_relative_path: parentPath,
          updated_at: new Date(),
        });
      });
    },

    async renameWorkflowFolderItem(relativePath: unknown, newName: unknown): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
      const sourceRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: false });
      const folderName = sanitizeWorkflowName(newName, 'new folder name');
      const parentRelativePath = path.posix.dirname(sourceRelativePath) === '.' ? '' : path.posix.dirname(sourceRelativePath);
      const targetRelativePath = parentRelativePath ? `${parentRelativePath}/${folderName}` : folderName;

      if (sourceRelativePath === targetRelativePath) {
        const folderRow = await deps.queryOne<FolderRow>(deps.pool, `
          SELECT relative_path, name, parent_relative_path, updated_at
          FROM workflow_folders WHERE relative_path = $1
        `, [sourceRelativePath]);
        if (!folderRow) {
          throw createHttpError(404, 'Folder not found');
        }

        return {
          folder: deps.mapFolderRowToFolderItem(folderRow),
          movedProjectPaths: [],
        };
      }

      if (targetRelativePath.startsWith(`${sourceRelativePath}/`)) {
        throw badRequest('Cannot move a folder into itself');
      }

      return moveFolderRelativePath(sourceRelativePath, targetRelativePath);
    },

    async moveWorkflowFolder(sourceRelativePath: unknown, destinationFolderRelativePath: unknown): Promise<{ folder: WorkflowFolderItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
      const sourcePath = normalizeManagedWorkflowRelativePath(sourceRelativePath, { allowProjectFile: false });
      const destinationFolderPath = normalizeManagedWorkflowRelativePath(destinationFolderRelativePath, { allowProjectFile: false, allowEmpty: true });
      const targetRelativePath = destinationFolderPath
        ? `${destinationFolderPath}/${path.posix.basename(sourcePath)}`
        : path.posix.basename(sourcePath);

      if (destinationFolderPath === sourcePath || destinationFolderPath.startsWith(`${sourcePath}/`)) {
        throw badRequest('Cannot move a folder into itself');
      }

      if (targetRelativePath === sourcePath) {
        const folderRow = await deps.queryOne<FolderRow>(deps.pool, `
          SELECT relative_path, name, parent_relative_path, updated_at
          FROM workflow_folders WHERE relative_path = $1
        `, [sourcePath]);
        if (!folderRow) {
          throw createHttpError(404, 'Folder not found');
        }

        return {
          folder: deps.mapFolderRowToFolderItem(folderRow),
          movedProjectPaths: [],
        };
      }

      return moveFolderRelativePath(sourcePath, targetRelativePath);
    },

    async deleteWorkflowFolderItem(relativePath: unknown): Promise<void> {
      const folderRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: false });

      await deps.withTransaction(async (client) => {
        await deps.assertFolderExists(client, folderRelativePath);

        const childFolder = await deps.queryOne(client, 'SELECT relative_path FROM workflow_folders WHERE parent_relative_path = $1 LIMIT 1', [folderRelativePath]);
        const childProject = await deps.queryOne(client, 'SELECT workflow_id FROM workflows WHERE folder_relative_path = $1 LIMIT 1', [folderRelativePath]);
        if (childFolder || childProject) {
          throw conflict('Only empty folders can be deleted');
        }

        await client.query('DELETE FROM workflow_folders WHERE relative_path = $1', [folderRelativePath]);
      });
    },

    async createWorkflowProjectItem(folderRelativePath: unknown, name: unknown): Promise<WorkflowProjectItem> {
      const normalizedFolderPath = normalizeManagedWorkflowRelativePath(folderRelativePath, { allowProjectFile: false, allowEmpty: true });
      const projectName = sanitizeWorkflowName(name, 'project name');
      const relativePath = normalizedFolderPath ? `${normalizedFolderPath}/${projectName}${WORKFLOW_PROJECT_EXTENSION}` : `${projectName}${WORKFLOW_PROJECT_EXTENSION}`;

      await deps.assertFolderExists(deps.pool, normalizedFolderPath);

      const result = await deps.saveHostedProject({
        projectPath: getManagedWorkflowProjectVirtualPath(relativePath),
        contents: createBlankProjectFile(projectName),
        datasetsContents: null,
      });

      return result.project;
    },

    async renameWorkflowProjectItem(relativePath: unknown, newName: unknown): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
      const sourceRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
      const projectName = sanitizeWorkflowName(newName, 'new project name');
      const folderRelativePath = path.posix.dirname(sourceRelativePath) === '.' ? '' : path.posix.dirname(sourceRelativePath);
      const targetRelativePath = folderRelativePath ? `${folderRelativePath}/${projectName}${WORKFLOW_PROJECT_EXTENSION}` : `${projectName}${WORKFLOW_PROJECT_EXTENSION}`;

      return moveWorkflowProjectRelativePath(sourceRelativePath, targetRelativePath);
    },

    async moveWorkflowProject(sourceRelativePath: unknown, destinationFolderRelativePath: unknown): Promise<{ project: WorkflowProjectItem; movedProjectPaths: WorkflowProjectPathMove[] }> {
      const sourcePath = normalizeManagedWorkflowRelativePath(sourceRelativePath, { allowProjectFile: true });
      const destinationFolderPath = normalizeManagedWorkflowRelativePath(destinationFolderRelativePath, { allowProjectFile: false, allowEmpty: true });
      const targetRelativePath = destinationFolderPath
        ? `${destinationFolderPath}/${path.posix.basename(sourcePath)}`
        : path.posix.basename(sourcePath);

      return moveWorkflowProjectRelativePath(sourcePath, targetRelativePath);
    },

    async duplicateWorkflowProjectItem(relativePath: unknown, version: WorkflowProjectDownloadVersion = 'live'): Promise<WorkflowProjectItem> {
      const sourceRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });

      return deps.withTransaction(async (client) => {
        const workflow = await deps.getWorkflowByRelativePath(client, sourceRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        const status = deps.getWorkflowStatus(workflow);
        const sourceRevisionId = version === 'published' ? workflow.published_revision_id : workflow.current_draft_revision_id;
        if (version === 'published' && !sourceRevisionId) {
          throw conflict('Published version is not available for this project');
        }

        const sourceRevision = await deps.getRevision(client, sourceRevisionId);
        if (!sourceRevision) {
          throw createHttpError(404, 'Project revision not found');
        }

        const sourceContents = await deps.readRevisionContents(sourceRevision);
        const [sourceProject, sourceAttachedData] = loadProjectAndAttachedDataFromString(sourceContents.contents);
        sourceProject.metadata.id = randomUUID() as typeof sourceProject.metadata.id;

        for (let duplicateIndex = 0; ; duplicateIndex += 1) {
          const duplicateProjectName = getWorkflowDuplicateProjectName(workflow.name, version, status, duplicateIndex);
          const duplicateRelativePath = workflow.folder_relative_path
            ? `${workflow.folder_relative_path}/${duplicateProjectName}${WORKFLOW_PROJECT_EXTENSION}`
            : `${duplicateProjectName}${WORKFLOW_PROJECT_EXTENSION}`;

          if (await deps.getWorkflowByRelativePath(client, duplicateRelativePath)) {
            continue;
          }

          sourceProject.metadata.title = duplicateProjectName;
          const serialized = serializeProject(sourceProject, sourceAttachedData);
          if (typeof serialized !== 'string') {
            throw createHttpError(400, 'Could not duplicate project');
          }

          const result = await deps.saveHostedProject({
            projectPath: getManagedWorkflowProjectVirtualPath(duplicateRelativePath),
            contents: serialized,
            datasetsContents: null,
          });
          return result.project;
        }
      });
    },

    async uploadWorkflowProjectItem(folderRelativePath: unknown, fileName: unknown, contents: unknown): Promise<WorkflowProjectItem> {
      const normalizedFolderPath = normalizeManagedWorkflowRelativePath(folderRelativePath, { allowProjectFile: false, allowEmpty: true });
      await deps.assertFolderExists(deps.pool, normalizedFolderPath);

      if (typeof fileName !== 'string' || !fileName.trim()) {
        throw createHttpError(400, 'Missing fileName');
      }
      if (typeof contents !== 'string' || !contents.trim()) {
        throw createHttpError(400, 'Missing project contents');
      }

      let sourceProject: Project;
      let attachedData: AttachedData;
      try {
        [sourceProject, attachedData] = loadProjectAndAttachedDataFromString(contents);
      } catch {
        throw createHttpError(400, 'Could not upload project: invalid project file');
      }

      const sourceBaseName = sanitizeWorkflowName(
        fileName.trim().replace(/\\/g, '/').split('/').pop()?.replace(/\.rivet-project$/i, '') ?? '',
        'project file name',
      );

      for (let uploadIndex = 0; ; uploadIndex += 1) {
        const uploadedProjectName = uploadIndex === 0 ? sourceBaseName : `${sourceBaseName} ${uploadIndex}`;
        const uploadedRelativePath = normalizedFolderPath
          ? `${normalizedFolderPath}/${uploadedProjectName}${WORKFLOW_PROJECT_EXTENSION}`
          : `${uploadedProjectName}${WORKFLOW_PROJECT_EXTENSION}`;

        if (await deps.getWorkflowByRelativePath(deps.pool, uploadedRelativePath)) {
          continue;
        }

        sourceProject.metadata.id = randomUUID() as typeof sourceProject.metadata.id;
        sourceProject.metadata.title = uploadedProjectName;
        const serialized = serializeProject(sourceProject, attachedData);
        if (typeof serialized !== 'string') {
          throw createHttpError(400, 'Could not upload project: invalid project file');
        }

        const result = await deps.saveHostedProject({
          projectPath: getManagedWorkflowProjectVirtualPath(uploadedRelativePath),
          contents: serialized,
          datasetsContents: null,
        });
        return result.project;
      }
    },

    async readWorkflowProjectDownload(relativePath: unknown, version: WorkflowProjectDownloadVersion): Promise<{ contents: string; fileName: string }> {
      const workflow = await deps.getWorkflowByRelativePath(deps.pool, normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true }));
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
      const normalizedRelativePath = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });

      return deps.withTransaction(async (client, hooks) => {
        const workflow = await deps.getWorkflowByRelativePath(client, normalizedRelativePath, { forUpdate: true });
        if (!workflow) {
          throw createHttpError(404, 'Project not found');
        }

        const revisions = await deps.queryRows<RevisionRow>(
          client,
          `
            SELECT revision_id, workflow_id, project_blob_key, dataset_blob_key, stats_graph_count, stats_total_node_count, created_at
            FROM workflow_revisions
            WHERE workflow_id = $1
          `,
          [workflow.workflow_id],
        );
        const recordings = await deps.queryRows<RecordingRow>(
          client,
          `
            SELECT ${deps.recordingColumns}
            FROM workflow_recordings
            WHERE workflow_id = $1
          `,
          [workflow.workflow_id],
        );

        await client.query('DELETE FROM workflows WHERE workflow_id = $1', [workflow.workflow_id]);
        await deps.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
        hooks.onCommit(() => deps.deleteBlobKeysBestEffort(
          `workflow deletion (${workflow.workflow_id})`,
          [
            ...revisions.flatMap((revision) => [revision.project_blob_key, revision.dataset_blob_key]),
            ...recordings.flatMap((recording) => [
              recording.recording_blob_key,
              recording.replay_project_blob_key,
              recording.replay_dataset_blob_key,
            ]),
          ],
        ));

        return workflow.workflow_id;
      });
    },
  };
}
