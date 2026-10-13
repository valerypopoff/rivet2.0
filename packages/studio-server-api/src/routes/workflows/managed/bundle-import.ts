import type { ManagedWorkflowContext } from './context.js';
import type { RevisionRow } from './types.js';
import type { PreparedProjectBundleImport } from '../project-bundle-import.js';
import { normalizeManagedWorkflowRelativePath } from '../virtual-paths.js';
import { sanitizeWorkflowName } from '../fs-helpers.js';
import { conflict, createHttpError } from '../../../utils/httpError.js';
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
  await context.initialize();
  await context.queries.assertFolderExists(context.pool, parentPath);
  const prepared: RevisionRow[] = [];
  let committed = false;
  try {
    for (const project of bundle.projects)
      prepared.push(await context.revisions.createRevision(project.id, project.contents, project.datasetsContents));
    const result = await context.withTransaction(async (client) => {
      // Protect the chosen parent against deletion or relocation until commit.
      if (parentPath) {
        const parent = await client.query(
          'SELECT relative_path FROM workflow_folders WHERE relative_path = $1 FOR KEY SHARE',
          [parentPath],
        );
        if (!parent.rowCount) throw createHttpError(404, 'Folder not found');
      }
      await client.query(
        'INSERT INTO workflow_folders (relative_path, name, parent_relative_path, updated_at) VALUES ($1,$2,$3,NOW())',
        [folderPath, name, parentPath],
      );
      const projects = [];
      for (const [index, project] of bundle.projects.entries()) {
        const fileName = `${project.name}.rivet-project`;
        const relativePath = `${folderPath}/${fileName}`;
        await client.query(
          `INSERT INTO workflows (workflow_id,name,file_name,relative_path,folder_relative_path,updated_at,current_draft_revision_id,published_revision_id,published_version_id,endpoint_name,published_endpoint_name,last_published_at)
          VALUES ($1,$2,$3,$4,$5,NOW(),$6,NULL,NULL,'','',NULL)`,
          [project.id, project.name, fileName, relativePath, folderPath, prepared[index]!.revision_id],
        );
        await context.revisions.insertRevision(client, prepared[index]!);
        const row = await context.queries.getWorkflowByRelativePath(client, relativePath);
        if (!row) throw new Error('Imported workflow could not be loaded.');
        projects.push(context.mappers.mapWorkflowRowToProjectItem(row));
      }
      const folder = context.mappers.mapFolderRowToFolderItem({
        relative_path: folderPath,
        name,
        parent_relative_path: parentPath,
        updated_at: new Date(),
      });
      folder.projects = projects;
      return { folder, projects, rootProjectId: bundle.rootProjectId };
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
