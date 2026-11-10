import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient, QueryResultRow } from 'pg';
import {
  loadProjectAndAttachedDataFromString,
  serializeProject,
  remapOwnedDatasets,
  serializeDatasets,
  getGraphBoundary,
  validateProjectBundleCall,
  ProjectBundleError,
  type Project,
  type ProjectId,
  type GraphId,
} from '@valerypopoff/rivet2-node';
import type {
  BundleMergeCatalog,
  BundleMergeChoices,
  BundleMergeCommit,
  BundleMergeDiagnostic,
  BundleMergePreview,
  BundleMergeResult,
  BundleMergeSite,
} from '../../../../../studio-server-shared/workflow-bundle-types.js';
import {
  mutationRequestText,
  type StructuralMutation,
} from '../../../../../studio-server-shared/workflow-mutation-contract.js';
import { PROJECT_REFERENCE_SUMMARY_VERSION } from '../project-reference-summary.js';
import { ACTIVE_REFERENCE_REVISIONS_SQL } from './reference-index.js';
import { queryReferences } from './reference-query.js';
import { PROJECT_BUNDLE_UPLOAD_MAX_BYTES } from '../../../../../studio-server-shared/project-bundle-types.js';
import { badRequest, conflict, createHttpError } from '../../../utils/httpError.js';
import { normalizeManagedWorkflowRelativePath, getManagedWorkflowProjectVirtualPath } from '../virtual-paths.js';
import { sanitizeWorkflowName } from '../fs-helpers.js';
import { bundleGraphKey, inspectBundleProjectBindings, remapBundleProject } from '../remap-bundle-project.js';
import { bundleMergeAdditionId, resolveBundleMerge } from '../bundle-merge-plan.js';
import { parseBundleDatasets } from '../bundle-datasets.js';
import { captureOperation } from './namespace-receipts.js';
import { createPreparedRevisions } from './prepared-revisions.js';
import { previousStructuralResult, structuralTransaction } from './structural-admission.js';
import type { ManagedWorkflowContext } from './context.js';
import type { FolderRow, WorkflowRow, RevisionRow } from './types.js';

export const bundleMergeDigest = (value: unknown) =>
  createHash('sha256').update(mutationRequestText(null, value)).digest('hex');
const digest = bundleMergeDigest;
const revisionIntegrityCode = 'bundle_merge_revision_integrity';
const revisionIntegrityConflict = (message: string) => createHttpError(409, message, { code: revisionIntegrityCode });
const diagnostic = (message: string, site?: BundleMergeSite): BundleMergeDiagnostic => ({
  id: digest({ message, site }),
  message,
  ...(site ? { site } : {}),
});
type Catalog = { root: FolderRow; members: WorkflowRow[]; folders: FolderRow[] };
type Fact = {
  id: string;
  path: string;
  name: string;
  bundleId: string | null;
  revision?: string;
  published?: string | null;
};

async function catalog(client: Pool | PoolClient, id: string): Promise<Catalog> {
  const root = (await client.query<FolderRow>('SELECT * FROM workflow_folders WHERE bundle_id=$1', [id])).rows[0];
  if (!root) throw createHttpError(404, 'Bundle not found. Refresh the library.');
  const members = (
    await client.query<WorkflowRow>(
      "SELECT * FROM workflows WHERE left(relative_path,length($1)+1)=$1 || '/' ORDER BY workflow_id LIMIT 257",
      [root.relative_path],
    )
  ).rows;
  const folders = (
    await client.query<FolderRow>(
      "SELECT * FROM workflow_folders WHERE relative_path=$1 OR left(relative_path,length($1)+1)=$1 || '/' ORDER BY relative_path LIMIT 513",
      [root.relative_path],
    )
  ).rows;
  if (members.length > 256 || folders.length > 512)
    throw badRequest('Bundles support at most 256 projects and 512 folders.');
  return { root, members, folders };
}
const describe = (value: Catalog): BundleMergeCatalog => ({
  bundleId: value.root.bundle_id!,
  namespaceId: value.root.namespace_id!,
  name: value.root.name,
  relativePath: value.root.relative_path,
  projects: value.members
    .map((row) => ({
      projectId: row.workflow_id,
      title: row.name,
      relativePath: row.relative_path.slice(value.root.relative_path.length + 1),
    }))
    .sort((a, b) => a.relativePath.localeCompare(b.relativePath)),
});
const rootFact = (value: Catalog) => [
  value.root.bundle_id,
  value.root.namespace_id,
  value.root.relative_path,
  value.root.name,
];

/** Canonical, destination-relative project path; never normalize an unsafe choice into another file. */
export function bundleMergePath(relativePath: string) {
  const normalized = normalizeManagedWorkflowRelativePath(relativePath, { allowProjectFile: true });
  if (normalized !== relativePath || !relativePath.endsWith('.rivet-project'))
    throw badRequest('Choose a canonical destination .rivet-project path.');
  const parts = relativePath.split('/');
  for (const folder of parts.slice(0, -1))
    if (sanitizeWorkflowName(folder, 'folder name') !== folder || folder.endsWith('.rivet-project'))
      throw badRequest('Invalid destination folder name.');
  const name = parts.at(-1)!.slice(0, -'.rivet-project'.length);
  if (sanitizeWorkflowName(name, 'project name') !== name) throw badRequest('Invalid destination project name.');
  return { name, relativePath };
}

/** SQL filters summaries before returning edges. No project-blob/library-history scan. */
async function incoming(client: Pool | PoolClient, destination: Catalog, replaced: string[], signal?: AbortSignal) {
  if (!replaced.length) return [];
  type IncomingRow = {
    workflow_id: string;
    revision_id: string;
    kind: string;
    label: string | null;
    valid: boolean;
    limited: boolean;
    edges: unknown[];
  };
  const sql = `
    WITH active AS (${ACTIVE_REFERENCE_REVISIONS_SQL}), callers AS (
      SELECT w.workflow_id, a.revision_id, a.kind, a.label, r.reference_summary AS summary,
        COALESCE(r.reference_summary->>'state'='complete'
          AND r.reference_summary->>'projectId'=w.workflow_id
          AND r.reference_summary->'version'=to_jsonb($3::int)
          AND jsonb_typeof(r.reference_summary->'graphCalls')='array',false) AS valid
      FROM active a JOIN workflows w USING(workflow_id)
      LEFT JOIN workflow_revisions r ON r.revision_id=a.revision_id
        AND r.workflow_id=w.workflow_id WHERE w.workflow_id=ANY($1::text[])
        AND (a.kind <> 'saved-latest' OR NOT w.workflow_id=ANY($2::text[]))
    ), candidates AS (
      SELECT * FROM callers ORDER BY workflow_id,revision_id,kind,label LIMIT 1001
    ), matches AS MATERIALIZED (
      SELECT c.workflow_id,c.revision_id,c.kind,c.label,e FROM candidates c
      CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN valid THEN summary->'graphCalls' ELSE '[]'::jsonb END) e
      WHERE e->>'targetProjectId'=ANY($2::text[]) AND e->>'targetVersion'<>'published'
      ORDER BY c.workflow_id,c.revision_id,c.kind,c.label LIMIT 1001
    ) SELECT c.workflow_id,c.revision_id,c.kind,c.label,c.valid,
      (SELECT count(*)>1000 FROM matches) AS limited,
      COALESCE((SELECT jsonb_agg(m.e) FROM matches m WHERE m.workflow_id=c.workflow_id AND m.revision_id=c.revision_id
        AND m.kind=c.kind AND m.label IS NOT DISTINCT FROM c.label), '[]'::jsonb) AS edges
    FROM candidates c ORDER BY workflow_id,revision_id,kind,label`;
  const values = [destination.members.map((row) => row.workflow_id), replaced, PROJECT_REFERENCE_SUMMARY_VERSION];
  const rows = signal
    ? await queryReferences<IncomingRow>(client as Pool, sql, values, signal, { timeoutMs: 30_000 })
    : (await client.query<IncomingRow>(sql, values)).rows;
  return rows
    .map((row, index) => (index === 1000 || (index === 0 && row.limited) ? { ...row, valid: false, edges: [] } : row))
    .filter((row) => !row.valid || row.edges.length);
}

export function createManagedBundleMergeService(context: ManagedWorkflowContext) {
  async function analyze(sourceId: string, choices: BundleMergeChoices, signal: AbortSignal) {
    signal.throwIfAborted();
    if (sourceId.toLowerCase() === choices.destinationBundleId.toLowerCase())
      throw badRequest('Choose a different destination bundle.');
    await context.initialize();
    signal.throwIfAborted();
    const readRows = <Row extends QueryResultRow>(sql: string, values: unknown[]) =>
      queryReferences<Row>(context.pool, sql, values, signal, { timeoutMs: 30_000 });
    const readArtifact = async (key: string, projectName: string) => {
      try {
        return await context.blobStore.getText(key, { signal });
      } catch (failure) {
        signal.throwIfAborted();
        throw Object.assign(
          createHttpError(
            503,
            `Could not read saved project ${projectName} from storage. Check storage and refresh the review.`,
            { expose: true },
          ),
          { cause: failure },
        );
      }
    };
    // One cancellable SQL snapshot, including pool acquisition, without holding a
    // transaction while downloading definitions or datasets.
    const catalogs = await readRows<Catalog>(
      `
      SELECT row_to_json(f) AS root,
        COALESCE((SELECT jsonb_agg(member) FROM (
          SELECT * FROM workflows WHERE left(relative_path,length(f.relative_path)+1)=f.relative_path || '/'
          ORDER BY workflow_id LIMIT 257) member), '[]'::jsonb) AS members,
        COALESCE((SELECT jsonb_agg(folder) FROM (
          SELECT * FROM workflow_folders WHERE relative_path=f.relative_path OR left(relative_path,length(f.relative_path)+1)=f.relative_path || '/'
          ORDER BY relative_path LIMIT 513) folder), '[]'::jsonb) AS folders
      FROM workflow_folders f WHERE f.bundle_id=ANY($1::uuid[])`,
      [[sourceId, choices.destinationBundleId]],
    );
    const source = catalogs.find((value) => value.root.bundle_id?.toLowerCase() === sourceId.toLowerCase());
    const destination = catalogs.find(
      (value) => value.root.bundle_id?.toLowerCase() === choices.destinationBundleId.toLowerCase(),
    );
    if (!source || !destination) throw createHttpError(404, 'Bundle not found. Refresh the library.');
    const sourceBundleId = source.root.bundle_id!,
      destinationBundleId = destination.root.bundle_id!;
    if (catalogs.some((value) => value.members.length > 256 || value.folders.length > 512))
      throw badRequest('Bundles support at most 256 projects and 512 folders.');
    const rows = new Map([...source.members, ...destination.members].map((row) => [row.workflow_id, row]));
    const facts = new Map<string, Fact>();
    const reads = new Map<
      string,
      Promise<{
        project: Project;
        attached: ReturnType<typeof loadProjectAndAttachedDataFromString>[1];
        revision: RevisionRow;
      }>
    >();
    let analysisBytes = 0;
    const sourceIds = new Set(source.members.map((row) => row.workflow_id));
    const destinationIds = new Set(destination.members.map((row) => row.workflow_id));
    async function row(id: string) {
      signal.throwIfAborted();
      let value = rows.get(id);
      if (value && facts.has(id)) return value;
      let externalBundleId: string | null = null;
      if (!value) {
        const external = (
          await readRows<WorkflowRow & { merge_bundle_id: string | null }>(
            `
          SELECT w.*, (SELECT f.bundle_id FROM workflow_folders f WHERE f.bundle_id IS NOT NULL AND
            (f.relative_path=w.folder_relative_path OR left(w.folder_relative_path,length(f.relative_path)+1)=f.relative_path || '/') LIMIT 1) AS merge_bundle_id
          FROM workflows w WHERE workflow_id=$1`,
            [id],
          )
        )[0];
        value = external;
        externalBundleId = external?.merge_bundle_id ?? null;
        if (!value) throw conflict('A referenced project is missing. Repair its binding before merging.');
        rows.set(id, value);
      }
      let bundleId: string | null;
      if (sourceIds.has(id)) bundleId = sourceBundleId;
      else if (destinationIds.has(id)) bundleId = destinationBundleId;
      else bundleId = externalBundleId;
      if (!facts.has(id)) facts.set(id, { id, path: value.relative_path, name: value.name, bundleId });
      return value;
    }
    async function load(id: string, version: 'latest' | 'published' = 'latest') {
      const owner = await row(id);
      const revisionId = version === 'published' ? owner.published_revision_id : owner.current_draft_revision_id;
      const fact = facts.get(id)!;
      if (version === 'published') fact.published = revisionId;
      else fact.revision = revisionId!;
      if (!revisionId)
        throw conflict(`Project ${owner.name} has no Published version. Choose Saved latest before merging.`);
      return loadRevision(id, revisionId);
    }
    async function loadRevision(id: string, revisionId: string) {
      const owner = await row(id);
      let read = reads.get(revisionId);
      if (!read) {
        read = (async () => {
          const revision = (
            await readRows<RevisionRow>('SELECT * FROM workflow_revisions WHERE revision_id=$1 AND workflow_id=$2', [
              revisionId,
              id,
            ])
          )[0];
          if (!revision || revision.workflow_id !== id)
            throw revisionIntegrityConflict('A project revision no longer matches its owner.');
          const contents = await readArtifact(revision.project_blob_key, owner.name);
          analysisBytes += Buffer.byteLength(contents);
          if (analysisBytes > 2 * PROJECT_BUNDLE_UPLOAD_MAX_BYTES)
            throw badRequest('Merge analysis exceeds 128 MiB. Select fewer changes.');
          let parsed;
          try {
            parsed = loadProjectAndAttachedDataFromString(contents);
          } catch {
            throw revisionIntegrityConflict(
              `Cannot read saved project ${owner.name}. Repair its saved content before merging.`,
            );
          }
          if (parsed[0].metadata.id !== id)
            throw revisionIntegrityConflict('A saved project identity does not match its revision.');
          return { project: parsed[0], attached: parsed[1], revision };
        })();
        reads.set(revisionId, read);
      }
      const loaded = await read;
      if (loaded.revision.workflow_id !== id || loaded.project.metadata.id !== id)
        throw revisionIntegrityConflict('A project revision no longer matches its owner.');
      return loaded;
    }
    const plan = await resolveBundleMerge(
      describe(source).projects,
      describe(destination).projects,
      choices,
      async (id) => (await load(id)).project,
    );
    const preview: BundleMergePreview = {
      source: describe(source),
      destination: describe(destination),
      actions: plan.actions,
      requiredProjects: plan.requiredProjects,
      requiredGraphs: [],
      blockers: [],
      warnings: [],
      rewrites: 0,
      versionChanges: 0,
      datasets: [],
    };
    const sourceWrites = new Map(plan.actions.map((action) => [action.sourceProjectId, action]));
    const replacementSources = new Map(
      plan.actions.flatMap((action) =>
        action.kind === 'replace' ? [[action.targetProjectId, action.sourceProjectId] as const] : [],
      ),
    );
    const graphMappings = new Map<string, string>();
    for (const graph of choices.graphs) {
      const key = bundleGraphKey(graph.sourceProjectId, graph.sourceGraphId);
      if (graphMappings.has(key)) throw badRequest('Duplicate graph correspondence.');
      graphMappings.set(key, graph.targetGraphId);
    }
    const graphChoices = new Map<string, BundleMergePreview['requiredGraphs'][number]>();
    const issue = (message: string, site: BundleMergeSite, warning = false) =>
      (warning ? preview.warnings : preview.blockers).push(diagnostic(message, site));
    const targetDefinition = async (
      id: string,
      version: 'latest' | 'published' = 'latest',
      originalSourceId?: string,
    ) => {
      // Resolve additions by source role, not by a preview-only string that an
      // authored project ID could happen to equal.
      // Only Saved latest bindings see replacement drafts; Published keeps its pointer.
      const sourceWrite =
        originalSourceId && sourceWrites.has(originalSourceId)
          ? originalSourceId
          : version === 'latest'
            ? replacementSources.get(id)
            : undefined;
      return load(sourceWrite ?? id, sourceWrite ? 'latest' : version);
    };
    for (const binding of plan.bindings) {
      const mapped = plan.mapping.get(binding.projectId);
      if (sourceIds.has(binding.projectId) && !mapped) continue;
      const targetId = mapped ?? binding.projectId;
      const key = bundleGraphKey(binding.projectId, binding.graphId ?? '');
      const graphId = (mapped ? graphMappings.get(key) : undefined) ?? binding.graphId;
      try {
        await row(binding.projectId);
        if (
          !mapped &&
          facts.get(binding.projectId)!.bundleId !== null &&
          facts.get(binding.projectId)!.bundleId !== destination.root.bundle_id
        ) {
          issue(
            'This binding points into another bundle. Choose an ordinary project or a destination member.',
            binding.site,
          );
          continue;
        }
        if (mapped) {
          preview.rewrites++;
          if (binding.version === 'published') preview.versionChanges++;
        }
        if (mapped && !sourceWrites.has(binding.projectId)) await row(targetId);
        if (binding.kind === 'reference') {
          await targetDefinition(targetId, 'latest', binding.projectId);
          continue;
        }
        if (!mapped && binding.invalidVersion) {
          issue(
            'The saved target version is invalid. Choose Published or Saved latest before merging.',
            binding.site,
            !binding.site.active,
          );
          continue;
        }
        const target = (await targetDefinition(targetId, mapped ? 'latest' : binding.version, binding.projectId))
          .project;
        if (
          mapped &&
          !sourceWrites.has(binding.projectId) &&
          binding.graphId &&
          (graphMappings.has(key) || (binding.site.active && !Object.hasOwn(target.graphs, binding.graphId)))
        ) {
          let entry = graphChoices.get(key);
          if (!entry) {
            const sourceTarget = (await load(binding.projectId)).project;
            entry = {
              sourceProjectId: binding.projectId,
              sourceGraphId: binding.graphId,
              sourceGraphName: sourceTarget.graphs[binding.graphId as GraphId]?.metadata?.name || binding.graphId,
              targetProjectId: targetId,
              options: Object.entries(target.graphs)
                .map(([id, graph]) => ({ id, name: graph.metadata?.name || id }))
                .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id)),
              sites: [],
              ...(graphMappings.has(key) ? { selectedGraphId: graphMappings.get(key)! } : {}),
            };
            graphChoices.set(key, entry);
          }
          entry.sites.push(binding.site);
          if (!entry.selectedGraphId) continue;
        }
        let boundary = binding.boundary;
        if (!boundary && mapped && !sourceWrites.has(binding.projectId) && binding.graphId) {
          const original = (await load(binding.projectId)).project;
          boundary = getGraphBoundary(original, binding.graphId as GraphId);
        }
        validateProjectBundleCall(
          { projectId: targetId, graphId: graphId ?? '', version: mapped ? 'latest' : binding.version, boundary },
          target,
        );
      } catch (error) {
        if (signal.aborted) throw error;
        const { status, code } = error as { status?: number; code?: string };
        if (status === 404 || status === 409) {
          issue((error as Error).message, binding.site, !binding.site.active && code !== revisionIntegrityCode);
          continue;
        }
        // Only Core's explicit graph-contract failures can become inactive warnings.
        if (status || !(error instanceof ProjectBundleError)) throw error;
        issue(
          `Target graph ${graphId || '(not selected)'} in ${sourceWrites.get(binding.projectId)?.kind === 'add' ? rows.get(binding.projectId)?.name : rows.get(targetId)?.name || targetId} is missing or has an incompatible saved wire boundary. Select a compatible graph or include the dependency's changes.`,
          binding.site,
          !binding.site.active,
        );
      }
    }
    preview.requiredGraphs = [...graphChoices.values()].filter((choice) => !choice.selectedGraphId);
    preview.mappedGraphs = [...graphChoices.values()].filter((choice) => !!choice.selectedGraphId);
    const placement = new Map<string, { id: string; name: string; path: string; added: boolean }>();
    const paths = new Set<string>();
    const folderFacts: Array<[string, string | null]> = [];
    for (const action of plan.actions) {
      if (action.kind === 'replace') {
        const target = await row(action.targetProjectId);
        facts.get(action.targetProjectId)!.revision = target.current_draft_revision_id;
        placement.set(action.sourceProjectId, {
          id: target.workflow_id,
          name: target.name,
          path: target.relative_path,
          added: false,
        });
        continue;
      }
      const location = bundleMergePath(action.relativePath);
      const path = `${destination.root.relative_path}/${location.relativePath}`;
      if (
        paths.has(path) ||
        destination.members.some((member) => member.relative_path === path) ||
        destination.folders.some((folder) => folder.relative_path === path)
      )
        throw conflict(`Destination ${location.relativePath} already exists. Choose another path.`);
      paths.add(path);
      const segments = path.split('/');
      for (let end = destination.root.relative_path.split('/').length + 1; end < segments.length; end++) {
        const ancestor = segments.slice(0, end).join('/');
        const folder = destination.folders.find((folder) => folder.relative_path === ancestor);
        folderFacts.push([ancestor, folder?.namespace_id ?? null]);
        if (folder?.bundle_id) throw conflict('A merge cannot create a project inside another bundle.');
      }
      placement.set(action.sourceProjectId, {
        id: bundleMergeAdditionId(action.sourceProjectId),
        name: location.name,
        path,
        added: true,
      });
    }
    const added = [...placement.values()].filter((value) => value.added).length;
    const newFolders = new Set(folderFacts.filter(([, id]) => !id).map(([path]) => path));
    if (destination.members.length + added > 256 || destination.folders.length + newFolders.size > 512)
      throw badRequest('The merged destination exceeds 256 projects or 512 folders.');
    const replaced = plan.actions.filter((action) => action.kind === 'replace').map((action) => action.targetProjectId);
    const incomingRows = await incoming(context.pool, destination, replaced, signal);
    const incompleteIncoming = incomingRows.filter((caller) => !caller.valid || caller.edges.length > 1000);
    if (incompleteIncoming.length)
      preview.warnings.push(
        diagnostic(
          `Incoming-reference review is incomplete for ${incompleteIncoming.length} active snapshots. Some reference summaries are unavailable or exceed the review limit. Existing callers may need review.`,
        ),
      );
    for (const caller of incomingRows) {
      if (!caller.valid || caller.edges.length > 1000) {
        continue;
      }
      const owner = (await loadRevision(caller.workflow_id, caller.revision_id)).project;
      for (const binding of inspectBundleProjectBindings(owner)) {
        if (!replaced.includes(binding.projectId) || binding.version === 'published' || binding.kind === 'reference')
          continue;
        const before = (await load(binding.projectId)).project;
        const after = (await targetDefinition(binding.projectId)).project;
        const call = {
          projectId: binding.projectId,
          graphId: binding.graphId ?? '',
          version: binding.version,
          boundary:
            binding.boundary ?? (binding.graphId ? getGraphBoundary(before, binding.graphId as GraphId) : undefined),
        };
        try {
          validateProjectBundleCall(call, before);
        } catch {
          continue;
        }
        try {
          validateProjectBundleCall(call, after);
        } catch {
          issue(
            `This existing ${caller.kind}${caller.label ? ` (${caller.label})` : ''} caller will lose a compatible target graph. Its contents will not be changed.`,
            binding.site,
            true,
          );
        }
      }
    }
    const warningMap = new Map(preview.warnings.map((value) => [value.id, value]));
    preview.warnings = [...warningMap.values()].sort((a, b) => a.id.localeCompare(b.id));
    if (preview.warnings.length > 1000 || preview.blockers.length > 1000)
      throw badRequest('The merge has more than 1,000 review issues. Select fewer changes.');
    let writeBytes = 0;
    const payloads = new Map<
      string,
      {
        project: Project;
        attached: ReturnType<typeof loadProjectAndAttachedDataFromString>[1];
        datasets: ReturnType<typeof parseBundleDatasets>;
      }
    >();
    if (
      plan.actions.length &&
      !preview.blockers.length &&
      !preview.requiredGraphs.length &&
      plan.requiredProjects.every((required) => plan.mapping.has(required.project.projectId))
    ) {
      for (const action of plan.actions) {
        const loaded = await load(action.sourceProjectId);
        const datasetsContents = loaded.revision.dataset_blob_key
          ? await readArtifact(loaded.revision.dataset_blob_key, rows.get(action.sourceProjectId)!.name)
          : null;
        writeBytes +=
          Buffer.byteLength(serializeProject(loaded.project, loaded.attached) as string) +
          Buffer.byteLength(datasetsContents ?? '');
        if (writeBytes > PROJECT_BUNDLE_UPLOAD_MAX_BYTES)
          throw badRequest('Merge writes exceed 64 MiB. Select fewer changes.');
        const datasets = parseBundleDatasets(datasetsContents, action.sourceProjectId);
        payloads.set(action.sourceProjectId, { project: loaded.project, attached: loaded.attached, datasets });
        preview.datasets.push({ sourceProjectId: action.sourceProjectId, count: datasets?.length ?? 0 });
      }
      preview.fingerprint = digest({
        choices,
        source: rootFact(source),
        destination: rootFact(destination),
        facts: [...facts.values()].sort((a, b) => a.id.localeCompare(b.id)),
        folderFacts,
        incoming: incomingRows,
        warnings: preview.warnings.map((warning) => warning.id),
      });
    }
    signal.throwIfAborted();
    if (Buffer.byteLength(JSON.stringify(preview)) > 2 * 1024 * 1024)
      throw badRequest('The merge review exceeds 2 MiB. Select fewer changes.');
    return { preview, source, destination, plan, facts, folderFacts, incomingRows, placement, payloads, graphMappings };
  }
  return {
    async preview(sourceId: string, choices: BundleMergeChoices, callerSignal?: AbortSignal) {
      const signal = callerSignal
        ? AbortSignal.any([callerSignal, AbortSignal.timeout(30_000)])
        : AbortSignal.timeout(30_000);
      try {
        return (await analyze(sourceId, choices, signal)).preview;
      } catch (error) {
        if (signal.aborted)
          throw createHttpError(
            504,
            'The merge review timed out or was cancelled. Review fewer changes or try the preview again.',
          );
        throw error;
      }
    },
    async commit(
      sourceId: string,
      request: BundleMergeCommit,
      mutation: StructuralMutation,
    ): Promise<BundleMergeResult> {
      const captured = captureOperation(
        { request, mutation },
        (input) => input.mutation,
        (input) => ({ operation: 'merge-bundle', input: { sourceBundleId: sourceId, ...input.request } }),
      );
      request = captured.input.request;
      mutation = captured.input.mutation;
      const previous = await previousStructuralResult<BundleMergeResult>(context, captured.admission);
      if (previous.state === 'committed') return previous.result;
      const signal = AbortSignal.timeout(120_000);
      const analysis = await analyze(sourceId, request.choices, signal);
      const { preview, source, destination, plan, placement } = analysis;
      if (!preview.fingerprint || preview.fingerprint !== request.fingerprint)
        throw conflict('The merge review changed. Review a fresh preview before merging.');
      if (
        JSON.stringify([...new Set(request.acknowledgedWarnings)].sort()) !==
        JSON.stringify(preview.warnings.map((value) => value.id).sort())
      )
        throw conflict('Acknowledge the current merge warnings before proceeding.');
      if (
        mutation.expectedSource?.id !== source.root.namespace_id ||
        mutation.expectedDestinationId !== destination.root.namespace_id
      )
        throw conflict('A selected bundle moved or was replaced. Refresh before merging.');
      const mapping = new Map(plan.mapping);
      for (const [id, target] of placement)
        if (target.added) {
          target.id = randomUUID();
          mapping.set(id, target.id);
        }
      const titles = new Map([...placement.values()].map((value) => [value.id, value.name]));
      for (const project of preview.destination.projects)
        if (!titles.has(project.projectId)) titles.set(project.projectId, project.title);
      const preparations = createPreparedRevisions(context.revisions, captured.admission);
      const prepared = new Map<string, RevisionRow>();
      try {
        const rewritten: Array<{ sourceId: string; id: string; contents: string; datasets: string | null }> = [];
        let rewrittenBytes = 0;
        for (const [id, payload] of analysis.payloads) {
          signal.throwIfAborted();
          const target = placement.get(id)!;
          const project = structuredClone(payload.project);
          remapBundleProject(project, mapping as Map<string, ProjectId>, { graphs: analysis.graphMappings, titles });
          project.metadata.title = target.name;
          if (
            inspectBundleProjectBindings(project).some((binding) =>
              analysis.source.members.some((member) => member.workflow_id === binding.projectId),
            )
          )
            throw conflict('An imported reference still points into the source bundle. Review its correspondence.');
          const datasets =
            payload.datasets === null
              ? null
              : serializeDatasets(remapOwnedDatasets(payload.datasets, id as ProjectId, target.id as ProjectId));
          const contents = serializeProject(project, payload.attached) as string;
          rewrittenBytes += Buffer.byteLength(contents) + Buffer.byteLength(datasets ?? '');
          if (rewrittenBytes > PROJECT_BUNDLE_UPLOAD_MAX_BYTES)
            throw badRequest('Rewritten merge content exceeds 64 MiB. Select fewer changes.');
          rewritten.push({ sourceId: id, id: target.id, contents, datasets });
        }
        for (const payload of rewritten) {
          signal.throwIfAborted();
          prepared.set(payload.sourceId, await preparations.prepare(payload.id, payload.contents, payload.datasets));
        }
        signal.throwIfAborted();
        return await structuralTransaction(
          context,
          captured.admission,
          async (client, hooks) => {
            await client.query(
              'SELECT workflow_id FROM workflows WHERE workflow_id=ANY($1::text[]) ORDER BY workflow_id FOR UPDATE',
              [[...analysis.facts.keys()].sort()],
            );
            const currentSource = await catalog(client, sourceId),
              currentDestination = await catalog(client, request.choices.destinationBundleId);
            if (
              digest(rootFact(currentSource)) !== digest(rootFact(source)) ||
              digest(rootFact(currentDestination)) !== digest(rootFact(destination))
            )
              throw conflict('A selected bundle changed. Review a fresh preview.');
            const currentRows = (
              await client.query<WorkflowRow>('SELECT * FROM workflows WHERE workflow_id=ANY($1::text[])', [
                [...analysis.facts.keys()],
              ])
            ).rows;
            for (const fact of analysis.facts.values()) {
              const current = currentRows.find((row) => row.workflow_id === fact.id);
              const membership =
                (current &&
                  (
                    await client.query<{ bundle_id: string }>(
                      "SELECT bundle_id FROM workflow_folders WHERE bundle_id IS NOT NULL AND (relative_path=$1 OR left($1,length(relative_path)+1)=relative_path || '/')",
                      [current.folder_relative_path],
                    )
                  ).rows[0]?.bundle_id) ??
                null;
              if (
                !current ||
                current.relative_path !== fact.path ||
                current.name !== fact.name ||
                membership !== fact.bundleId ||
                (fact.revision !== undefined && current.current_draft_revision_id !== fact.revision) ||
                (fact.published !== undefined && current.published_revision_id !== fact.published)
              )
                throw conflict('A consumed project changed during merge preparation. Review a fresh preview.');
            }
            if (
              digest(await incoming(client, currentDestination, replacedIds(plan.actions))) !==
              digest(analysis.incomingRows)
            )
              throw conflict('Incoming-reference warnings changed. Review a fresh preview.');
            const newFolders = new Set<string>();
            for (const entry of analysis.folderFacts) {
              if (
                (currentDestination.folders.find((folder) => folder.relative_path === entry[0])?.namespace_id ??
                  null) !== entry[1]
              )
                throw conflict('An addition folder changed. Review a fresh preview.');
              if (!entry[1]) newFolders.add(entry[0]);
            }
            if (
              currentDestination.members.length + [...placement.values()].filter((value) => value.added).length > 256 ||
              currentDestination.folders.length + newFolders.size > 512
            )
              throw conflict('The destination grew beyond the bundle limits. Review a smaller merge.');
            for (const target of placement.values())
              if (
                target.added &&
                (currentDestination.members.some((row) => row.relative_path === target.path) ||
                  currentDestination.folders.some((row) => row.relative_path === target.path))
              )
                throw conflict('An addition path is now occupied. Choose another path.');
            for (const path of [...newFolders].sort()) await context.queries.ensureFolderChain(client, path);
            const projects: BundleMergeResult['projects'] = [];
            for (const [id, target] of placement) {
              const revision = prepared.get(id)!;
              if (target.added) {
                const folder = target.path.slice(0, target.path.lastIndexOf('/'));
                await client.query(
                  'INSERT INTO workflows(workflow_id,name,file_name,relative_path,folder_relative_path,current_draft_revision_id) VALUES($1,$2,$3,$4,$5,$6)',
                  [target.id, target.name, `${target.name}.rivet-project`, target.path, folder, revision.revision_id],
                );
                await context.revisions.insertRevision(client, revision);
              } else {
                await context.revisions.insertRevision(client, revision);
                await client.query(
                  'UPDATE workflows SET current_draft_revision_id=$2,updated_at=NOW() WHERE workflow_id=$1',
                  [target.id, revision.revision_id],
                );
              }
              preparations.stage(revision, hooks);
              await context.executionInvalidationController.queueWorkflowInvalidation(client, hooks, target.id);
              projects.push({
                projectId: target.id,
                path: getManagedWorkflowProjectVirtualPath(target.path),
                revisionId: revision.revision_id,
                added: target.added,
              });
            }
            await context.executionInvalidationController.queueCatalogInvalidation(client);
            return {
              operationId: mutation.operationId,
              folder: context.mappers.mapFolderRowToFolderItem(currentDestination.root),
              projectMapping: Object.fromEntries(mapping),
              projects,
              warnings: preview.warnings,
            };
          },
          preparations,
        );
      } finally {
        await preparations.close();
      }
    },
  };
}

function replacedIds(actions: BundleMergePreview['actions']) {
  return actions.flatMap((action) => (action.kind === 'replace' ? [action.targetProjectId] : []));
}
