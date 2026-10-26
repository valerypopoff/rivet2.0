import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { badRequest, conflict, createHttpError } from '../../../utils/httpError.js';
import { WORKFLOW_PROJECT_EXTENSION } from '../../../../../studio-server-shared/workflow-types.js';
import type { WorkflowNamespaceCommand } from '../../../../../studio-server-shared/workflow-namespace-types.js';
import { sanitizeWorkflowName } from '../fs-helpers.js';
import { normalizeManagedWorkflowRelativePath, getManagedWorkflowProjectVirtualPath } from '../virtual-paths.js';
import type { ManagedWorkflowContext } from './context.js';
import type { CatalogTransaction } from './structural-admission.js';
import type { FolderMoveRow, FolderRow } from './types.js';
import { deleteManagedWorkflowProject } from './project-deletion.js';

type Dependencies = Pick<
  ManagedWorkflowContext,
  'queries' | 'db' | 'mappers' | 'maintenance' | 'executionInvalidationController'
>;

/** SQL-only operations. The caller owns the transaction and topology lease.
 * No pool, transaction factory, initializer or object-store dependency is exposed. */
export function createManagedCatalogMutations({
  queries,
  db,
  mappers,
  maintenance,
  executionInvalidationController,
}: Dependencies) {
  return async (tx: CatalogTransaction, command: WorkflowNamespaceCommand) => {
    const { client, hooks } = tx;
    const source = normalizeManagedWorkflowRelativePath(command.relativePath, {
      allowProjectFile: command.itemType === 'project',
    });
    if (command.kind === 'delete') {
      if (command.itemType === 'project') {
        const workflow = await queries.getWorkflowByRelativePath(client, source, { forUpdate: true });
        if (!workflow) throw createHttpError(404, 'Project not found');
        await deleteManagedWorkflowProject(
          { db, mappers, maintenance, executionInvalidationController },
          client,
          hooks,
          workflow,
        );
        return { deleted: true as const, projectId: workflow.workflow_id };
      }
      const folder = await db.queryOne(
        client,
        'SELECT relative_path FROM workflow_folders WHERE relative_path=$1 FOR UPDATE',
        [source],
      );
      if (!folder) throw createHttpError(404, 'Folder not found');
      const childFolder = await db.queryOne(
        client,
        'SELECT relative_path FROM workflow_folders WHERE parent_relative_path = $1 LIMIT 1',
        [source],
      );
      const childProject = await db.queryOne(
        client,
        'SELECT workflow_id FROM workflows WHERE folder_relative_path = $1 LIMIT 1',
        [source],
      );
      if (childFolder || childProject) throw conflict('Only empty folders can be deleted');
      await client.query('DELETE FROM workflow_folders WHERE relative_path=$1', [source]);
      await executionInvalidationController.queueCatalogInvalidation(client);
      return { deleted: true as const };
    }
    const parent =
      command.kind === 'rename'
        ? path.posix.dirname(source) === '.'
          ? ''
          : path.posix.dirname(source)
        : normalizeManagedWorkflowRelativePath(command.destinationRelativePath, {
            allowProjectFile: false,
            allowEmpty: true,
          });
    const name =
      command.kind === 'rename'
        ? sanitizeWorkflowName(command.name, 'new name') +
          (command.itemType === 'project' ? WORKFLOW_PROJECT_EXTENSION : '')
        : path.posix.basename(source);
    const target = normalizeManagedWorkflowRelativePath(parent ? `${parent}/${name}` : name, {
      allowProjectFile: command.itemType === 'project',
    });
    if (command.itemType === 'folder') {
      if (parent === source || parent.startsWith(source + '/') || target.startsWith(source + '/'))
        throw badRequest('Cannot move a folder into itself');
      if (target === source) {
        const folder = await db.queryOne<FolderRow>(
          client,
          'SELECT relative_path,name,parent_relative_path,updated_at,bundle_id,namespace_id FROM workflow_folders WHERE relative_path=$1',
          [source],
        );
        if (!folder) throw createHttpError(404, 'Folder not found');
        return { folder: mappers.mapFolderRowToFolderItem(folder), movedProjectPaths: [] };
      }
      try {
        const row = await db.queryOne<FolderMoveRow>(
          client,
          'SELECT relative_path,name,parent_relative_path,updated_at,moved_relative_paths FROM move_managed_workflow_folder($1,$2,$3,$4)',
          [source, `.__move__-${randomUUID()}`, target, path.posix.basename(target)],
        );
        if (!row) throw createHttpError(500, 'Moved folder could not be loaded');
        const movedProjectPaths = (row.moved_relative_paths ?? []).map((relativePath) => ({
          fromAbsolutePath: getManagedWorkflowProjectVirtualPath(relativePath),
          toAbsolutePath: getManagedWorkflowProjectVirtualPath(target + relativePath.slice(source.length)),
        }));
        if (movedProjectPaths.length) await executionInvalidationController.queueGlobalInvalidation(client, hooks);
        else await executionInvalidationController.queueCatalogInvalidation(client);
        return {
          folder: mappers.mapFolderRowToFolderItem({
            ...row,
            ...(await db.queryOne<{ bundle_id: string | null; namespace_id: string }>(
              client,
              'SELECT bundle_id,namespace_id FROM workflow_folders WHERE relative_path=$1',
              [target],
            )),
          }),
          movedProjectPaths,
        };
      } catch (error) {
        const code = (error as { code?: string }).code;
        if (code === '23514') throw conflict('Bundles cannot contain other bundles.');
        if (code === 'P0002') throw createHttpError(404, 'Folder not found');
        if (db.isUniqueViolation(error)) throw conflict(`Folder already exists: ${path.posix.basename(target)}`);
        throw error;
      }
    }
    const workflow = await queries.getWorkflowByRelativePath(client, source, { forUpdate: true });
    if (!workflow) throw createHttpError(404, 'Project not found');
    if (source === target) return { project: mappers.mapWorkflowRowToProjectItem(workflow), movedProjectPaths: [] };
    if (await queries.getWorkflowByRelativePath(client, target)) throw conflict(`Project already exists: ${name}`);
    await queries.assertFolderExists(client, parent);
    await client.query(
      `UPDATE workflows SET name=$2,file_name=$3,relative_path=$4,folder_relative_path=$5,updated_at=NOW() WHERE workflow_id=$1`,
      [workflow.workflow_id, path.posix.basename(target, WORKFLOW_PROJECT_EXTENSION), name, target, parent],
    );
    const moved = await queries.getWorkflowByRelativePath(client, target, { forUpdate: true });
    if (!moved) throw createHttpError(500, 'Moved project could not be loaded');
    await executionInvalidationController.queueWorkflowInvalidation(client, hooks, workflow.workflow_id);
    return {
      project: mappers.mapWorkflowRowToProjectItem(moved),
      movedProjectPaths: [
        {
          fromAbsolutePath: getManagedWorkflowProjectVirtualPath(source),
          toAbsolutePath: getManagedWorkflowProjectVirtualPath(target),
        },
      ],
    };
  };
}
