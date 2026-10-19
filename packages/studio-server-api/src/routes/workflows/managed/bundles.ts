import { createHash, randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import {
  deserializeDatasets,
  loadProjectAndAttachedDataFromString,
  serializeDatasets,
  serializeProject,
  listProjectBundleCalls,
  validateProjectBundleCall,
  ProjectBundleError,
  type Project,
  type ProjectId,
} from '@valerypopoff/rivet2-node';
import type {
  WorkflowBundlePreview,
  WorkflowBundleVersion,
} from '../../../../../studio-server-shared/workflow-bundle-types.js';
import { PROJECT_BUNDLE_UPLOAD_MAX_BYTES } from '../../../../../studio-server-shared/project-bundle-types.js';
import { badRequest, conflict, createHttpError } from '../../../utils/httpError.js';
import { normalizeManagedWorkflowRelativePath } from '../virtual-paths.js';
import { sanitizeWorkflowName } from '../fs-helpers.js';
import { remapBundleProject } from '../remap-bundle-project.js';
import type { ManagedWorkflowContext } from './context.js';
import type { FolderRow, RevisionRow, WorkflowRow } from './types.js';

export const lockBundleTopology = (client: PoolClient) => client.query('SELECT pg_advisory_xact_lock(8071, 24016)');

export function createManagedBundleService(context: ManagedWorkflowContext) {
  async function capture(client: PoolClient, id: string, version: WorkflowBundleVersion, lock = false) {
    const root = (await client.query<FolderRow>('SELECT * FROM workflow_folders WHERE bundle_id = $1', [id])).rows[0];
    if (!root) throw createHttpError(404, 'Bundle not found');
    const members = (
      await client.query<WorkflowRow>(
        `SELECT * FROM workflows WHERE left(relative_path, length($1) + 1) = $1 || '/' ORDER BY relative_path LIMIT 257 ${lock ? 'FOR SHARE' : ''}`,
        [root.relative_path],
      )
    ).rows;
    if (members.length > 256) throw badRequest('Bundles support at most 256 projects.');
    const descendants = (
      await client.query<FolderRow>(
        `SELECT * FROM workflow_folders WHERE relative_path = $1 OR left(relative_path, length($1) + 1) = $1 || '/' ORDER BY relative_path LIMIT 513`,
        [root.relative_path],
      )
    ).rows;
    if (descendants.length > 512) throw badRequest('Bundles support at most 512 folders.');
    const selected = members.map((row) => ({
      projectId: row.workflow_id,
      relativePath: row.relative_path,
      revisionId: (version === 'published' && row.published_revision_id) || row.current_draft_revision_id,
      selectedVersion:
        version === 'published' && row.published_revision_id ? ('published' as const) : ('latest' as const),
    }));
    const fingerprint = createHash('sha256')
      .update(
        JSON.stringify({ id, version, folders: descendants.map((f) => [f.relative_path, f.bundle_id]), selected }),
      )
      .digest('hex');
    return { root, folders: descendants, selected, fingerprint, members };
  }
  async function read(id: string, version: WorkflowBundleVersion) {
    await context.initialize();
    const snapshot = await context.withTransaction(async (client) => {
      await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
      return capture(client, id, version);
    });
    let bytes = 0;
    const projects = [];
    const ids = new Map(snapshot.members.map((member) => [member.workflow_id, randomUUID() as ProjectId]));
    const external = new Set<string>();
    const definitions = new Map<string, Project>();
    const warnings: string[] = [];
    for (const member of snapshot.selected) {
      const revision = await context.queries.getRevision(context.pool, member.revisionId);
      if (!revision) throw conflict('A source revision is unavailable. Refresh the preview.');
      const contents = await context.revisions.readRevisionContents(revision);
      bytes += Buffer.byteLength(contents.contents) + Buffer.byteLength(contents.datasetsContents ?? '');
      if (bytes > PROJECT_BUNDLE_UPLOAD_MAX_BYTES)
        throw badRequest('Bundle duplication exceeds 64 MiB of decoded content.');
      const [project, attached] = loadProjectAndAttachedDataFromString(contents.contents);
      if (project.metadata.id !== member.projectId)
        throw conflict('A source project identity does not match its revision.');
      for (const target of remapBundleProject(project, ids)) external.add(target);
      definitions.set(project.metadata.id, project);
      const datasets = contents.datasetsContents === null ? null : deserializeDatasets(contents.datasetsContents);
      for (const dataset of datasets ?? []) {
        if (dataset.meta.projectId !== member.projectId)
          throw badRequest('Dataset ownership does not match the source project.');
        dataset.meta.projectId = project.metadata.id;
      }
      projects.push({
        member,
        id: project.metadata.id,
        contents: serializeProject(project, attached) as string,
        datasetsContents: datasets === null ? null : serializeDatasets(datasets),
      });
    }
    for (const project of definitions.values()) {
      try {
        for (const call of listProjectBundleCalls(project)) {
          const target = definitions.get(call.projectId);
          if (target) validateProjectBundleCall(call, target);
        }
      } catch (failure) {
        warnings.push(
          `${project.metadata.title}: ${failure instanceof Error ? failure.message : 'Unresolved graph definition.'} The saved definition is retained; review it before running the copy.`,
        );
      }
    }
    const preview: WorkflowBundlePreview = {
      bundleId: id,
      name: snapshot.root.name,
      relativePath: snapshot.root.relative_path,
      version,
      fingerprint: snapshot.fingerprint,
      members: snapshot.selected,
      externalProjectIds: [...external].sort(),
      warnings,
    };
    return { snapshot, projects, preview };
  }
  return {
    async exportSnapshot(id: string, version: WorkflowBundleVersion) {
      await context.initialize();
      const snapshot = await context.withTransaction(async (client) => {
        await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
        return capture(client, id, version);
      });
      if (!snapshot.members.length) throw new ProjectBundleError('Add a project before downloading this bundle.');
      return {
        name: snapshot.root.name,
        folders: snapshot.folders
          .filter((f) => f.relative_path !== snapshot.root.relative_path)
          .map((f) => f.relative_path.slice(snapshot.root.relative_path.length + 1)),
        members: snapshot.selected.map((m) => ({
          projectId: m.projectId,
          relativePath: m.relativePath.slice(snapshot.root.relative_path.length + 1),
        })),
        firstProjectPath: snapshot.selected[0]!.relativePath,
        fingerprint: snapshot.fingerprint,
      };
    },
    async setKind(relativePath: string, enabled: boolean) {
      const source = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: false });
      await context.initialize();
      return context.withTransaction(async (client) => {
        await lockBundleTopology(client);
        const rows = await client.query<FolderRow>(
          'SELECT * FROM workflow_folders WHERE relative_path = $1 FOR UPDATE',
          [source],
        );
        const row = rows.rows[0];
        if (!row) throw createHttpError(404, 'Folder not found');
        const id = enabled ? row.bundle_id ?? randomUUID() : null;
        const result = await client.query<FolderRow>(
          'UPDATE workflow_folders SET bundle_id=$2, updated_at=NOW() WHERE relative_path=$1 RETURNING *',
          [source, id],
        );
        await context.executionInvalidationController.queueCatalogInvalidation(client);
        return context.mappers.mapFolderRowToFolderItem(result.rows[0]!);
      });
    },
    async create(name: string, parentRelativePath: string) {
      const parent = normalizeManagedWorkflowRelativePath(parentRelativePath, {
        allowProjectFile: false,
        allowEmpty: true,
      });
      const title = sanitizeWorkflowName(name, 'bundle name');
      const target = normalizeManagedWorkflowRelativePath(parent ? `${parent}/${title}` : title, {
        allowProjectFile: false,
      });
      await context.initialize();
      return context.withTransaction(async (client) => {
        await lockBundleTopology(client);
        await context.queries.assertFolderExists(client, parent);
        const result = await client.query<FolderRow>(
          `INSERT INTO workflow_folders(relative_path,name,parent_relative_path,bundle_id) VALUES($1,$2,$3,$4) RETURNING *`,
          [target, title, parent, randomUUID()],
        );
        await context.executionInvalidationController.queueCatalogInvalidation(client);
        return context.mappers.mapFolderRowToFolderItem(result.rows[0]!);
      });
    },
    async preview(id: string, version: WorkflowBundleVersion) {
      return (await read(id, version)).preview;
    },
    async duplicate(
      id: string,
      options: { version: WorkflowBundleVersion; fingerprint: string; name: string; parentRelativePath: string },
    ) {
      const parent = normalizeManagedWorkflowRelativePath(options.parentRelativePath, {
        allowProjectFile: false,
        allowEmpty: true,
      });
      const name = sanitizeWorkflowName(options.name, 'bundle name');
      const target = normalizeManagedWorkflowRelativePath(parent ? `${parent}/${name}` : name, {
        allowProjectFile: false,
      });
      const { snapshot, projects, preview } = await read(id, options.version);
      if (preview.fingerprint !== options.fingerprint)
        throw conflict('The bundle changed. Review a fresh preview before duplicating.');
      const bundleId = randomUUID();
      const prepared: RevisionRow[] = [];
      let committed = false;
      try {
        for (const project of projects)
          prepared.push(await context.revisions.createRevision(project.id, project.contents, project.datasetsContents));
        const result = await context.withTransaction(async (client) => {
          await lockBundleTopology(client);
          const current = await capture(client, id, options.version, true);
          if (current.fingerprint !== options.fingerprint)
            throw conflict('The bundle changed during duplication. Review it again.');
          await context.queries.assertFolderExists(client, parent);
          const containing = await client.query(
            `SELECT 1 FROM workflow_folders WHERE bundle_id IS NOT NULL AND (relative_path=$1 OR left($1,length(relative_path)+1)=relative_path || '/')`,
            [parent],
          );
          if (containing.rowCount) throw conflict('A bundle cannot be duplicated inside another bundle.');
          let folder: FolderRow | undefined;
          for (const source of snapshot.folders) {
            const isRoot = source.relative_path === snapshot.root.relative_path;
            const path = target + source.relative_path.slice(snapshot.root.relative_path.length);
            const parentPath = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '';
            const created = await client.query<FolderRow>(
              `INSERT INTO workflow_folders(relative_path,name,parent_relative_path,bundle_id) VALUES($1,$2,$3,$4) RETURNING *`,
              [path, isRoot ? name : source.name, parentPath, isRoot ? bundleId : null],
            );
            if (isRoot) folder = created.rows[0];
          }
          for (const [index, project] of projects.entries()) {
            const source = snapshot.members[index]!;
            const relativePath = target + source.relative_path.slice(snapshot.root.relative_path.length);
            const folderPath = relativePath.slice(0, relativePath.lastIndexOf('/'));
            await client.query(
              `INSERT INTO workflows(workflow_id,name,file_name,relative_path,folder_relative_path,current_draft_revision_id) VALUES($1,$2,$3,$4,$5,$6)`,
              [project.id, source.name, source.file_name, relativePath, folderPath, prepared[index]!.revision_id],
            );
            await context.revisions.insertRevision(client, prepared[index]!);
          }
          await context.executionInvalidationController.queueCatalogInvalidation(client);
          return { folder: context.mappers.mapFolderRowToFolderItem(folder!), bundleId };
        });
        committed = true;
        return result;
      } finally {
        if (!committed) for (const revision of prepared) await context.revisions.discardPreparedRevision(revision);
      }
    },
  };
}
