import { loadProjectAndAttachedDataFromString } from '@valerypopoff/rivet2-node';
import type {
  BundleComparisonCatalog,
  BundleComparisonManifest,
  BundleComparisonPairRequest,
  BundleComparisonPairResult,
} from '../../../../../studio-server-shared/workflow-bundle-comparison-types.js';
import { createHttpError } from '../../../utils/httpError.js';
import { getManagedWorkflowProjectVirtualPath } from '../virtual-paths.js';
import { queryReferences } from './reference-query.js';
import type { ManagedWorkflowContext } from './context.js';
import type { FolderRow, RevisionRow, WorkflowRow } from './types.js';

export function createManagedBundleComparisonService(context: ManagedWorkflowContext) {
  return {
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
