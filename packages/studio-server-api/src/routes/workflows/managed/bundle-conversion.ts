import type { PoolClient } from 'pg';
import { loadProjectFromString } from '@valerypopoff/rivet2-node';
import { PROJECT_BUNDLE_UPLOAD_MAX_BYTES } from '../../../../../studio-server-shared/project-bundle-types.js';
import { conflict, createHttpError } from '../../../utils/httpError.js';
import { listBundleProjectReferenceIds } from '../remap-bundle-project.js';
import type { ManagedWorkflowContext } from './context.js';
import type { FolderRow, WorkflowRow } from './types.js';

async function members(client: PoolClient, source: string, lock = false) {
  const rows = (
    await client.query<WorkflowRow>(
      `SELECT * FROM workflows WHERE left(relative_path, length($1) + 1) = $1 || '/' ORDER BY relative_path LIMIT 257 ${lock ? 'FOR SHARE' : ''}`,
      [source],
    )
  ).rows;
  if (rows.length > 256) throw conflict('Bundles support at most 256 projects.');
  return rows;
}

type WebAppRevision = { workflow_id: string; revision_id: string };
async function capture(client: PoolClient, source: string, lock = false) {
  const rows = await members(client, source, lock);
  // Publication commands lock their workflow row before changing these bindings.
  // Take the member locks first on the final read; no extra app locks are needed.
  const webApps = rows.length
    ? (
        await client.query<WebAppRevision>(
          'SELECT DISTINCT workflow_id, revision_id FROM workflow_web_apps WHERE workflow_id = ANY($1::text[]) ORDER BY workflow_id, revision_id',
          [rows.map((row) => row.workflow_id)],
        )
      ).rows
    : [];
  return { rows, webApps };
}

const fingerprint = ({ rows, webApps }: { rows: WorkflowRow[]; webApps: WebAppRevision[] }) =>
  JSON.stringify([
    rows.map((row) => [row.workflow_id, row.relative_path, row.current_draft_revision_id, row.published_revision_id]),
    webApps,
  ]);

/** Read immutable project blobs without holding the topology lease or workflow locks. */
export async function prepareBundleConversion(context: ManagedWorkflowContext, source: string) {
  const snapshot = await context.withTransaction(async (client) => {
    await client.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ');
    const folder = (await client.query<FolderRow>('SELECT * FROM workflow_folders WHERE relative_path = $1', [source]))
      .rows[0];
    if (!folder) throw createHttpError(404, 'Folder not found');
    return {
      bundleId: folder.bundle_id,
      ...(folder.bundle_id ? { rows: [], webApps: [] } : await capture(client, source)),
    };
  });
  const internal = new Set(snapshot.rows.map((row) => row.workflow_id));
  const references: { source: string; version: string; targets: string[] }[] = [];
  let bytes = 0;
  for (const row of snapshot.rows) {
    const seen = new Set<string>();
    for (const [version, id] of [
      ['saved draft', row.current_draft_revision_id],
      ['published', row.published_revision_id],
      ...snapshot.webApps
        .filter((app) => app.workflow_id === row.workflow_id)
        .map((app) => ['published web app', app.revision_id] as const),
    ] as const) {
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const revision = await context.queries.getRevision(context.pool, id);
      if (!revision || revision.workflow_id !== row.workflow_id)
        throw conflict('A saved project revision is unavailable. Conversion was not performed.');
      const contents = await context.revisions.readRevisionProjectContents(revision);
      bytes += Buffer.byteLength(contents);
      // Published web apps may also retain older snapshots. Do not download datasets.
      if (bytes > 2 * PROJECT_BUNDLE_UPLOAD_MAX_BYTES)
        throw conflict('Bundle conversion exceeds 128 MiB of saved project content.');
      let project;
      try {
        project = loadProjectFromString(contents, { logErrors: false });
      } catch {
        throw conflict(
          `Cannot check saved project ${row.relative_path} (${version}). Repair its saved content before converting. Nothing was changed.`,
        );
      }
      if (project.metadata.id !== row.workflow_id)
        throw conflict('A saved project identity does not match its revision. Conversion was not performed.');
      references.push({
        source: row.relative_path,
        version,
        targets: [...listBundleProjectReferenceIds(project)].filter((id) => !internal.has(id)),
      });
    }
  }
  return { bundleId: snapshot.bundleId, fingerprint: fingerprint(snapshot), references };
}

/** Caller holds the topology lease. Row locks fence draft saves/publication through commit. */
export async function assertBundleConversion(
  client: PoolClient,
  source: string,
  prepared: Awaited<ReturnType<typeof prepareBundleConversion>>,
) {
  if (prepared.bundleId || fingerprint(await capture(client, source, true)) !== prepared.fingerprint)
    throw conflict('Folder projects changed while checking references. Retry conversion.');
  const ids = [...new Set(prepared.references.flatMap((reference) => reference.targets))];
  if (!ids.length) return;
  const targets = (
    await client.query<{ workflow_id: string; relative_path: string; bundle_path: string }>(
      `SELECT w.workflow_id, w.relative_path, f.relative_path AS bundle_path
       FROM workflows w JOIN workflow_folders f ON f.bundle_id IS NOT NULL AND
         (f.relative_path=w.folder_relative_path OR left(w.folder_relative_path,length(f.relative_path)+1)=f.relative_path || '/')
       WHERE w.workflow_id = ANY($1::text[])`,
      [ids],
    )
  ).rows;
  const forbidden = new Map(targets.map((target) => [target.workflow_id, target]));
  for (const reference of prepared.references) {
    const targetId = reference.targets.find((id) => forbidden.has(id));
    const target = targetId ? forbidden.get(targetId) : undefined;
    if (target)
      throw createHttpError(
        409,
        `Cannot convert to bundle: ${reference.source} (${reference.version}) references ${target.relative_path} in another bundle (${target.bundle_path}). Retarget it to a project in this folder or to an ordinary project, then retry. Nothing was changed.`,
        { code: 'bundle_cross_bundle_reference' },
      );
  }
}
