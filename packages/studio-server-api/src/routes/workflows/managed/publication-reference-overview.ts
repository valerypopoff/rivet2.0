import type {
  WorkflowBundleReferenceDetails,
  WorkflowReferenceOverview,
  WorkflowReleaseDependencyStatus,
  WorkflowReleaseSelector,
} from '../../../../../studio-server-shared/workflow-types.js';
import { createHttpError } from '../../../utils/httpError.js';
import { PROJECT_REFERENCE_SUMMARY_VERSION } from '../project-reference-summary.js';
import type { ManagedWorkflowContext } from './context.js';
import { indexEndpointReleaseTargets, parseEndpointReleaseManifest } from './endpoint-release-manifest.js';
import {
  endpointReleaseWritesEnabled,
  readDependencyPointers,
  selectDependencyRevision,
} from './endpoint-release-selection.js';
import { isSubgraphReferenceInScope } from './subgraph-access.js';

const BUNDLE_REFERENCES_SQL = `
WITH bundle_members AS (
  SELECT b.bundle_id, w.workflow_id, w.name, w.relative_path, r.created_at, r.reference_summary AS summary
  FROM workflows w
  JOIN workflow_folders b ON b.bundle_id IS NOT NULL AND
    (b.relative_path = w.folder_relative_path OR left(w.folder_relative_path,length(b.relative_path)+1) = b.relative_path || '/')
  LEFT JOIN workflow_revisions r ON r.revision_id = w.current_draft_revision_id AND r.workflow_id = w.workflow_id
  WHERE $1::uuid IS NULL OR b.bundle_id = $1::uuid
), checked AS (
  SELECT *, COALESCE(summary->>'state' = 'complete' AND summary->>'projectId' = workflow_id
    AND summary->'version' = to_jsonb($2::integer) AND jsonb_typeof(summary->'projectTargets') = 'array', FALSE) AS covered
  FROM bundle_members
), external_targets AS (
  SELECT c.*, t->>'projectId' AS target_id, t->>'version' AS selector
  FROM checked c
  CROSS JOIN LATERAL jsonb_array_elements(CASE WHEN c.covered THEN summary->'projectTargets' ELSE '[]'::jsonb END) t
  LEFT JOIN bundle_members target ON target.bundle_id = c.bundle_id AND target.workflow_id = t->>'projectId'
  WHERE target.workflow_id IS NULL AND t->>'projectId' IS NOT NULL
)
`;

function readReferenceManifest(manifest: unknown, owner: string, rootRevisionId: string | null) {
  if (!manifest || !rootRevisionId) return null;
  const parsed = parseEndpointReleaseManifest(manifest, owner, rootRevisionId);
  if (!parsed) return null;
  const { targets } = indexEndpointReleaseTargets(parsed);
  return targets ? { projects: parsed.projects, targets } : null;
}

export async function readWorkflowReferenceOverview(
  context: ManagedWorkflowContext,
): Promise<WorkflowReferenceOverview> {
  return context.withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const bundles = await client.query<{ bundleId: string; count: number; complete: boolean }>(
      `
      ${BUNDLE_REFERENCES_SQL}
      SELECT c.bundle_id AS "bundleId", COALESCE(t.target_count, 0)::integer AS count, c.complete
      FROM (SELECT bundle_id, bool_and(covered AND jsonb_typeof(summary->'graphCalls') IS NOT DISTINCT FROM 'array') AS complete
        FROM checked GROUP BY bundle_id) c
      LEFT JOIN (SELECT bundle_id, count(DISTINCT target_id) AS target_count FROM external_targets GROUP BY bundle_id) t USING (bundle_id)
    `,
      [null, PROJECT_REFERENCE_SUMMARY_VERSION],
    );
    // Keep catalog requests independent of project bodies and cap payload size.
    const active = await client.query<{
      workflow_id: string;
      root_revision_id: string | null;
      manifest: unknown;
      standalone: boolean;
      omitted: boolean;
      uncaptured: boolean;
    }>(
      `
      WITH live AS (
        SELECT w.workflow_id, r.revision_id AS root_revision_id, rel.manifest,
          r.revision_id IS NOT NULL AND v.release_id IS NULL
            AND (w.published_version_id IS NULL OR v.version_id IS NOT NULL) AS uncaptured,
          COALESCE(r.reference_summary->>'state' = 'complete'
            AND r.reference_summary->>'projectId' = w.workflow_id
            AND r.reference_summary->'version' = to_jsonb($1::integer)
            AND r.reference_summary->'projectTargets' = '[]'::jsonb, FALSE) AS standalone
        FROM workflows w
        LEFT JOIN workflow_revisions r ON r.revision_id = w.published_revision_id AND r.workflow_id = w.workflow_id
        LEFT JOIN workflow_published_versions v ON v.version_id = w.published_version_id AND v.workflow_id = w.workflow_id
          AND v.revision_id = r.revision_id
        LEFT JOIN workflow_endpoint_releases rel ON rel.release_id = v.release_id AND rel.workflow_id = w.workflow_id
        WHERE w.published_revision_id IS NOT NULL
        ORDER BY w.workflow_id LIMIT 1001
      ), budgeted AS (
        SELECT *, sum(coalesce(octet_length(manifest::text), 0)) OVER (ORDER BY workflow_id) AS metadata_size
        FROM live
      )
      SELECT workflow_id, root_revision_id, standalone, uncaptured,
        CASE WHEN metadata_size <= 12582912 THEN manifest END AS manifest,
        manifest IS NOT NULL AND metadata_size > 12582912 AS omitted
      FROM budgeted ORDER BY workflow_id
    `,
      [PROJECT_REFERENCE_SUMMARY_VERSION],
    );
    const scoped = active.rows.slice(0, 1000).map(({ manifest, root_revision_id, ...entry }) => ({
      ...entry,
      release: readReferenceManifest(manifest, entry.workflow_id, root_revision_id),
    }));
    let available = active.rows.length <= scoped.length && !scoped.some((entry) => entry.omitted);
    const targets = new Set<string>();
    for (const entry of scoped) {
      for (const project of entry.release?.projects.values() ?? []) targets.add(project.projectId);
    }
    const pointers = await readDependencyPointers(client, [...targets]);
    const endpoints: WorkflowReferenceOverview['endpoints'] = [];
    const captureEnabled = endpointReleaseWritesEnabled();
    let dependencyCount = 0;
    for (const entry of scoped) {
      const dependencies = new Map<string, WorkflowReleaseDependencyStatus>();
      const release = entry.release;
      if (release) {
        for (const { artifactId, callerProjectIds, selector } of release.targets.values()) {
          const target = release.projects.get(artifactId)!;
          if (target.projectId === entry.workflow_id) continue;
          const pointer = pointers.get(target.projectId);
          const current = selectDependencyRevision(pointer, selector);
          const targetBundleId = pointer?.bundle_id;
          const scopeChanged = selector !== 'project-reference' && !!targetBundleId &&
            [...callerProjectIds].some((id) => !isSubgraphReferenceInScope(pointers.get(id)?.bundle_id, targetBundleId));
          const existing = dependencies.get(target.projectId);
          const revisions = existing?.revisions ?? [];
          revisions.push({ selector, activeRevisionId: artifactId, savedRevisionId: current });
          dependencies.set(target.projectId, {
            projectId: target.projectId,
            name: pointer?.name ?? target.name,
            relativePath: pointer?.relative_path ?? null,
            changed: !!existing?.changed || current !== artifactId || scopeChanged,
            unavailable: !!existing?.unavailable || !current || scopeChanged,
            revisions,
          });
        }
      }
      dependencyCount += dependencies.size;
      if (dependencyCount > 12_000) {
        available = false;
        break;
      }
      endpoints.push({
        projectId: entry.workflow_id,
        coverage: release || (entry.uncaptured && entry.standalone) ? 'complete' : 'project-only',
        ...(captureEnabled && entry.uncaptured ? { canCaptureRelease: true } : {}),
        dependencies: [...dependencies.values()],
      });
    }
    return { bundles: bundles.rows, endpoints, complete: available };
  });
}

type BundleUseRow = {
  target_id: string;
  name: string | null;
  relative_path: string | null;
  source_path: string;
  source_name: string;
  graph_name: string | null;
  node_title: string | null;
  target_graph: string | null;
  selector: WorkflowReleaseSelector;
  saved_at: Date;
};

export async function readWorkflowBundleReferenceDetails(
  context: ManagedWorkflowContext,
  bundleId: string,
): Promise<WorkflowBundleReferenceDetails> {
  return context.withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
    await client.query("SET LOCAL statement_timeout = '5s'");
    const coverage = await client.query<{ complete: boolean }>(
      `
      ${BUNDLE_REFERENCES_SQL}
      SELECT COALESCE(
        bool_and(covered AND jsonb_typeof(summary->'graphCalls') IS NOT DISTINCT FROM 'array')
          FILTER (WHERE c.workflow_id IS NOT NULL), TRUE
      ) AS complete
      FROM workflow_folders b LEFT JOIN checked c ON c.bundle_id = b.bundle_id
      WHERE b.bundle_id = $1::uuid GROUP BY b.bundle_id
    `,
      [bundleId, PROJECT_REFERENCE_SUMMARY_VERSION],
    );
    if (!coverage.rows[0]) throw createHttpError(404, 'Bundle not found.');
    const details = await client.query<BundleUseRow>(
      `
      ${BUNDLE_REFERENCES_SQL}
      SELECT e.target_id, target.name, target.relative_path,
        e.relative_path AS source_path, e.name AS source_name, e.created_at AS saved_at, e.selector,
        call->>'sourceGraphName' AS graph_name, call->>'nodeTitle' AS node_title, call->>'targetGraphId' AS target_graph
      FROM external_targets e
      LEFT JOIN workflows target ON target.workflow_id = e.target_id
      LEFT JOIN LATERAL (
        SELECT call FROM jsonb_array_elements(CASE WHEN jsonb_typeof(e.summary->'graphCalls') = 'array'
          THEN e.summary->'graphCalls' ELSE '[]'::jsonb END) call
        WHERE call->>'targetProjectId' = e.target_id AND call->>'targetVersion' = e.selector
      ) sites ON true
      ORDER BY target.name, e.target_id, e.relative_path, call->>'sourceGraphName', call->>'nodeTitle'
      LIMIT 4001
    `,
      [bundleId, PROJECT_REFERENCE_SUMMARY_VERSION],
    );
    const projects = new Map<string, WorkflowBundleReferenceDetails['projects'][number]>();
    for (const row of details.rows.slice(0, 4000)) {
      const project = projects.get(row.target_id) ?? {
        projectId: row.target_id,
        name: row.name ?? row.target_id,
        relativePath: row.relative_path,
        uses: [],
      };
      project.uses.push({
        sourceName: row.source_name,
        sourcePath: row.source_path,
        sourceGraphName: row.graph_name ?? undefined,
        nodeTitle: row.node_title ?? undefined,
        targetGraphId: row.target_graph ?? undefined,
        selector: row.selector,
        savedAt: new Date(row.saved_at).toISOString(),
      });
      projects.set(row.target_id, project);
    }
    return { complete: coverage.rows[0].complete && details.rows.length <= 4000, projects: [...projects.values()] };
  });
}
