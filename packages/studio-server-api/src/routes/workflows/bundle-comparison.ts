import { loadProjectAndAttachedDataFromString } from '@valerypopoff/rivet2-node';
import type { ProjectId } from '@valerypopoff/rivet2-node';
import { createHash } from 'node:crypto';
import { mutationRequestText } from '../../../../studio-server-shared/workflow-mutation-contract.js';
import { remapBundleProject } from './remap-bundle-project.js';
import type {
  BundleComparisonCatalog,
  BundleComparisonManifest,
  BundleComparisonPairRequest,
  BundleComparisonPairResult,
  BundleComparisonChangesRequest,
  BundleComparisonChanges,
} from '@valerypopoff/rivet-studio-server-shared/workflow-bundle-comparison-types.js';
import { createHttpError } from '../../utils/httpError.js';
import { getManagedWorkflowProjectVirtualPath } from './virtual-paths.js';
import { queryReferences } from './managed/reference-query.js';
import type { ManagedWorkflowContext } from './managed/context.js';
import type { FolderRow, RevisionRow, WorkflowRow } from './managed/types.js';

export function createManagedBundleComparisonService(context: ManagedWorkflowContext) {
  return {
    async changes(input: BundleComparisonChangesRequest, signal: AbortSignal): Promise<BundleComparisonChanges> {
      if (input.olderId.toLowerCase() === input.newerId.toLowerCase())
        throw createHttpError(400, 'Choose two different bundles.');
      if (
        new Set(input.pairs.map((p) => p.olderId)).size !== input.pairs.length ||
        new Set(input.pairs.map((p) => p.newerId)).size !== input.pairs.length
      )
        throw createHttpError(400, 'Comparison pairs must be one-to-one.');
      if (!input.pairs.length) return { changedNewerIds: [] };
      await context.initialize();
      const requested = input.pairs.flatMap((p) => [
        { bundle_id: input.olderId, project_id: p.olderId, revision_id: p.olderRevisionId },
        { bundle_id: input.newerId, project_id: p.newerId, revision_id: null },
      ]);
      const rows = await queryReferences<{ project: WorkflowRow | null; revision: RevisionRow | null }>(
        context.pool,
        `
        SELECT row_to_json(w) AS project, row_to_json(r) AS revision
        FROM jsonb_to_recordset($1::jsonb) AS q(bundle_id uuid,project_id text,revision_id text)
        LEFT JOIN workflow_folders f ON f.bundle_id=q.bundle_id
        LEFT JOIN workflows w ON w.workflow_id=q.project_id
          AND left(w.relative_path,length(f.relative_path)+1)=f.relative_path || '/'
        LEFT JOIN workflow_revisions r ON r.workflow_id=w.workflow_id
          AND r.revision_id=COALESCE(q.revision_id,w.current_draft_revision_id)`,
        [JSON.stringify(requested)],
        signal,
      );
      if (rows.length !== requested.length || rows.some((row) => !row.project || !row.revision))
        throw createHttpError(409, 'A compared project or saved revision is unavailable. Restart comparison.');
      const ids = new Map(input.pairs.map((p) => [p.olderId, p.newerId as ProjectId]));
      const titles = new Map(rows.map((row) => [row.project!.workflow_id, row.project!.name]));
      const hashes = new Map<string, string>();
      for (let offset = 0; offset < rows.length; offset += 4) {
        signal.throwIfAborted();
        await Promise.all(
          rows.slice(offset, offset + 4).map(async (row) => {
            const id = row.project!.workflow_id;
            const contents = await context.revisions.readRevisionProjectContents(row.revision!, { signal });
            signal.throwIfAborted();
            const [project, attached] = loadProjectAndAttachedDataFromString(contents);
            if (project.metadata.id !== id)
              throw createHttpError(409, 'The saved snapshot has a different project identity.');
            if (ids.has(id)) remapBundleProject(project, ids, { titles, preserveVersions: true });
            delete project.metadata.path;
            for (const reference of project.references ?? [])
              if (titles.has(reference.id)) {
                delete reference.hintPaths;
                reference.title = titles.get(ids.get(reference.id) ?? reference.id);
              }
            hashes.set(id, createHash('sha256').update(mutationRequestText(null, { project, attached })).digest('hex'));
          }),
        );
      }
      return {
        changedNewerIds: input.pairs
          .filter(
            (p) => titles.get(p.olderId) !== titles.get(p.newerId) || hashes.get(p.olderId) !== hashes.get(p.newerId),
          )
          .map((p) => p.newerId),
      };
    },
    async manifest(olderId: string, newerId: string, signal: AbortSignal): Promise<BundleComparisonManifest> {
      if (olderId.toLowerCase() === newerId.toLowerCase()) throw createHttpError(400, 'Choose two different bundles.');
      await context.initialize();
      const rows = await queryReferences<{ root: FolderRow; members: WorkflowRow[]; folders: FolderRow[] }>(
        context.pool,
        `
        SELECT row_to_json(f) AS root,
          COALESCE((SELECT jsonb_agg(m) FROM (SELECT * FROM workflows w
            WHERE left(w.relative_path,length(f.relative_path)+1)=f.relative_path || '/'
            ORDER BY w.relative_path LIMIT 257) m), '[]'::jsonb) AS members,
          COALESCE((SELECT jsonb_agg(d) FROM (SELECT * FROM workflow_folders d
            WHERE d.relative_path=f.relative_path OR left(d.relative_path,length(f.relative_path)+1)=f.relative_path || '/'
            ORDER BY d.relative_path LIMIT 513) d), '[]'::jsonb) AS folders
        FROM workflow_folders f WHERE f.bundle_id=ANY($1::uuid[])`,
        [[olderId, newerId]],
        signal,
      );
      const catalog = (id: string): BundleComparisonCatalog => {
        const row = rows.find((r) => r.root.bundle_id?.toLowerCase() === id.toLowerCase());
        if (!row) throw createHttpError(404, 'A selected bundle is unavailable. Refresh the library.');
        if (row.members.length > 256 || row.folders.length > 512)
          throw createHttpError(400, 'Bundles support at most 256 projects and 512 folders.');
        const prefix = row.root.relative_path.length + 1;
        return {
          bundleId: row.root.bundle_id!,
          name: row.root.name,
          relativePath: row.root.relative_path,
          folders: row.folders
            .filter((f) => f.relative_path !== row.root.relative_path)
            .map((f) => f.relative_path.slice(prefix)),
          projects: row.members.map((p) => ({
            projectId: p.workflow_id,
            name: p.name,
            relativePath: p.relative_path.slice(prefix),
            revisionId: p.current_draft_revision_id,
            publishedRevisionId: p.published_revision_id,
          })),
        };
      };
      return { older: catalog(olderId), newer: catalog(newerId), capturedAt: new Date().toISOString() };
    },
    async pair(input: BundleComparisonPairRequest, signal: AbortSignal): Promise<BundleComparisonPairResult> {
      if (!input.older && !input.newer) throw createHttpError(400, 'Select a project to compare.');
      if (input.older && input.newer && input.older.bundleId.toLowerCase() === input.newer.bundleId.toLowerCase())
        throw createHttpError(400, 'Choose two different bundles.');
      await context.initialize();
      const requested = Object.entries(input)
        .filter(([, value]) => value)
        .map(([side, p]) => ({
          side,
          bundle_id: p!.bundleId,
          project_id: p!.projectId,
          revision_id: side === 'older' ? input.older!.revisionId : null,
        }));
      const rows = await queryReferences<{
        side: string;
        project: WorkflowRow | null;
        revision: RevisionRow | null;
        bundle_id: string | null;
      }>(
        context.pool,
        `
        SELECT q.side, row_to_json(w) AS project, row_to_json(r) AS revision, f.bundle_id
        FROM jsonb_to_recordset($1::jsonb) AS q(side text,bundle_id uuid,project_id text,revision_id text)
        LEFT JOIN workflow_folders f ON f.bundle_id=q.bundle_id
        LEFT JOIN workflows w ON w.workflow_id=q.project_id
          AND left(w.relative_path,length(f.relative_path)+1)=f.relative_path || '/'
        LEFT JOIN workflow_revisions r ON r.workflow_id=w.workflow_id AND r.revision_id=q.revision_id`,
        [JSON.stringify(requested)],
        signal,
      );
      for (const row of rows)
        if (!row.project || !row.bundle_id)
          throw createHttpError(
            409,
            'A compared project moved or is no longer in its selected bundle. Review project matching.',
          );
      const older = rows.find((r) => r.side === 'older');
      const newer = rows.find((r) => r.side === 'newer');
      let reference: BundleComparisonPairResult['older'] = null;
      if (input.older) {
        if (!older?.revision || older.revision.workflow_id !== input.older.projectId)
          throw createHttpError(410, 'The saved Older revision is unavailable. Refresh older version.');
        let contents: string;
        try {
          contents = await context.revisions.readRevisionProjectContents(older.revision, { signal });
        } catch {
          signal.throwIfAborted();
          throw createHttpError(
            422,
            `Could not read the saved Older project "${older.project?.name}". Refresh older version.`,
          );
        }
        signal.throwIfAborted();
        let project;
        try {
          [project] = loadProjectAndAttachedDataFromString(contents);
        } catch {
          throw createHttpError(
            422,
            `Could not parse the saved Older project "${older.project?.name}". Refresh older version.`,
          );
        }
        if (project.metadata.id !== input.older.projectId)
          throw createHttpError(409, 'The Older snapshot does not belong to the selected project.');
        reference = { ...input.older, contents };
      }
      if (input.newer && !newer?.project)
        throw createHttpError(409, 'The Newer project is unavailable. Review project matching.');
      return {
        older: reference,
        newer:
          input.newer && newer?.project
            ? {
                bundleId: newer.bundle_id!,
                projectId: newer.project.workflow_id,
                path: getManagedWorkflowProjectVirtualPath(newer.project.relative_path),
              }
            : null,
      };
    },
  };
}
