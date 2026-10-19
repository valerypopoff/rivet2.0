import type { ManagedWorkflowContext } from './context.js';
import type { RevisionRow } from './types.js';
import type { PreparedProjectBundleImport } from '../project-bundle-import.js';
import { normalizeManagedWorkflowRelativePath } from '../virtual-paths.js';
import { sanitizeWorkflowName } from '../fs-helpers.js';
import { conflict, createHttpError } from '../../../utils/httpError.js';
import { lockBundleTopology } from './bundles.js';
import { randomUUID } from 'node:crypto';
import type { ProjectBundleImportResult } from '../../../../../studio-server-shared/project-bundle-types.js';

/** Immutable artifacts are prepared outside SQL; the complete folder/group becomes visible in one commit. */
export async function importManagedProjectBundle(
  context: ManagedWorkflowContext,
  parent: string,
  bundle: PreparedProjectBundleImport,
): Promise<ProjectBundleImportResult> {
  const parentPath = normalizeManagedWorkflowRelativePath(parent, { allowProjectFile: false, allowEmpty: true });
  const name = sanitizeWorkflowName(bundle.folderName, 'bundle folder name');
  const folderPath = parentPath ? `${parentPath}/${name}` : name;
  const dependencyName = `${name} dependencies`;
  const dependencyPath = parentPath ? `${parentPath}/${dependencyName}` : dependencyName;
  const hasDependencies = bundle.projects.some((project) => project.externalDependency);
  await context.initialize();
  await context.queries.assertFolderExists(context.pool, parentPath);
  const prepared: RevisionRow[] = [];
  let committed = false;
  try {
    for (const project of bundle.projects)
      prepared.push(await context.revisions.createRevision(project.id, project.contents, project.datasetsContents));
    const result = await context.withTransaction(async (client) => {
      await lockBundleTopology(client);
      // Protect the chosen parent against deletion or relocation until commit.
      if (parentPath) {
        const parent = await client.query(
          'SELECT relative_path FROM workflow_folders WHERE relative_path = $1 FOR KEY SHARE',
          [parentPath],
        );
        if (!parent.rowCount) throw createHttpError(404, 'Folder not found');
      }
      const owners = await client.query(
        "SELECT bundle_id FROM workflow_folders WHERE bundle_id IS NOT NULL AND (relative_path=$1 OR left($1,length(relative_path)+1)=relative_path || '/')",
        [parentPath],
      );
      if (owners.rowCount) throw conflict('Upload this bundle outside an existing bundle; bundles cannot be nested.');
      const bundleId = randomUUID();
      await client.query(
        'INSERT INTO workflow_folders (relative_path, name, parent_relative_path, updated_at, bundle_id) VALUES ($1,$2,$3,NOW(),$4)',
        [folderPath, name, parentPath, bundleId],
      );
      const folderItems = new Map<string, ReturnType<typeof context.mappers.mapFolderRowToFolderItem>>();
      const addFolderItem = (relativePath: string, title: string, parent: string, id: string | null) => {
        const item = context.mappers.mapFolderRowToFolderItem({
          relative_path: relativePath,
          name: title,
          parent_relative_path: parent,
          updated_at: new Date(),
          bundle_id: id,
        });
        folderItems.set(relativePath, item);
        folderItems.get(parent)?.folders.push(item);
        return item;
      };
      const folder = addFolderItem(folderPath, name, parentPath, bundleId);
      for (const relative of [...(bundle.folders ?? [])].sort()) {
        const subPath = `${folderPath}/${relative}`;
        const parent = subPath.slice(0, subPath.lastIndexOf('/'));
        const title = relative.split('/').at(-1)!;
        await client.query('INSERT INTO workflow_folders(relative_path,name,parent_relative_path) VALUES($1,$2,$3)', [
          subPath,
          title,
          parent,
        ]);
        addFolderItem(subPath, title, parent, null);
      }
      let dependenciesFolder;
      if (hasDependencies) {
        await client.query('INSERT INTO workflow_folders(relative_path,name,parent_relative_path) VALUES($1,$2,$3)', [
          dependencyPath,
          dependencyName,
          parentPath,
        ]);
        dependenciesFolder = addFolderItem(dependencyPath, dependencyName, parentPath, null);
      }
      const projects = [];
      for (const [index, project] of bundle.projects.entries()) {
        const fileName = `${project.name}.rivet-project`;
        const projectFolder = project.externalDependency
          ? dependencyPath
          : project.folder
            ? `${folderPath}/${project.folder}`
            : folderPath;
        const relativePath = `${projectFolder}/${fileName}`;
        await client.query(
          `INSERT INTO workflows (workflow_id,name,file_name,relative_path,folder_relative_path,updated_at,current_draft_revision_id,published_revision_id,published_version_id,endpoint_name,published_endpoint_name,last_published_at)
          VALUES ($1,$2,$3,$4,$5,NOW(),$6,NULL,NULL,'','',NULL)`,
          [project.id, project.name, fileName, relativePath, projectFolder, prepared[index]!.revision_id],
        );
        await context.revisions.insertRevision(client, prepared[index]!);
        const row = await context.queries.getWorkflowByRelativePath(client, relativePath);
        if (!row) throw new Error('Imported workflow could not be loaded.');
        const item = context.mappers.mapWorkflowRowToProjectItem(row);
        item.bundleId = project.externalDependency ? null : bundleId;
        projects.push(item);
        folderItems.get(projectFolder)?.projects.push(item);
      }
      await context.executionInvalidationController.queueCatalogInvalidation(client);
      return {
        folder,
        projects,
        rootProjectId: bundle.rootProjectId,
        ...(dependenciesFolder ? { dependenciesFolder } : {}),
      };
    });
    committed = true;
    return result;
  } catch (error) {
    if (context.db.isUniqueViolation(error))
      throw conflict('The bundle import destination changed. Upload again to create a new folder.');
    throw error;
  } finally {
    if (!committed) for (const revision of prepared) await context.revisions.discardPreparedRevision(revision);
  }
}
