import type { QueryResultRow } from 'pg';

import type { ManagedWorkflowContext } from './context.js';
import { toIsoString } from './mappers.js';
import type { ManagedWorkflowMigrationSnapshot } from './types.js';

type WorkflowRow = QueryResultRow & {
  workflow_id: string;
  relative_path: string;
  name: string;
  file_name: string;
  updated_at: Date | string;
  current_draft_revision_id: string;
  published_revision_id: string | null;
  published_version_id: string | null;
  endpoint_name: string;
  endpoint_access: 'public' | 'internal';
  publication_version: string;
  published_endpoint_name: string;
  last_published_at: Date | string | null;
};
type RevisionRow = QueryResultRow & {
  revision_id: string;
  project_blob_key: string;
  dataset_blob_key: string | null;
};
type VersionRow = QueryResultRow & {
  version_id: string;
  revision_id: string;
  endpoint_name: string;
  published_at: Date | string;
  is_starred: boolean;
  comment: string;
};
type WebAppRow = QueryResultRow & {
  app_id: string;
  revision_id: string;
  ui_graph_id: string;
  slug: string;
  allowed_emails: string[];
  published_at: Date | string;
};

/** Reads the stored object bytes, rather than trusting matching row counts or derived UI status. */
export async function readManagedWorkflowMigrationSnapshot(
  context: ManagedWorkflowContext,
  relativePath: string,
): Promise<ManagedWorkflowMigrationSnapshot | null> {
  await context.initialize();
  const result = await context.pool.query<WorkflowRow>(
    `SELECT workflow_id, relative_path, name, file_name, updated_at, current_draft_revision_id,
            published_revision_id, published_version_id, endpoint_name, endpoint_access,
            publication_version, published_endpoint_name, last_published_at
     FROM workflows WHERE relative_path = $1`,
    [relativePath],
  );
  const workflow = result.rows[0];
  if (!workflow) return null;
  const [revisionRows, versionRows, webAppRows] = await Promise.all([
    context.pool.query<RevisionRow>(
      'SELECT revision_id, project_blob_key, dataset_blob_key FROM workflow_revisions WHERE workflow_id = $1',
      [workflow.workflow_id],
    ),
    context.pool.query<VersionRow>(
      `SELECT version_id, revision_id, endpoint_name, published_at, is_starred, comment
       FROM workflow_published_versions WHERE workflow_id = $1 ORDER BY version_id`,
      [workflow.workflow_id],
    ),
    context.pool.query<WebAppRow>(
      `SELECT app_id, revision_id, ui_graph_id, slug, allowed_emails, published_at
       FROM workflow_web_apps WHERE workflow_id = $1 ORDER BY ui_graph_id`,
      [workflow.workflow_id],
    ),
  ]);
  const revisions = new Map(revisionRows.rows.map((revision) => [revision.revision_id, revision]));
  const readRevision = async (revisionId: string): Promise<{ contents: string; datasetsContents: string | null }> => {
    const revision = revisions.get(revisionId);
    if (!revision) throw new Error(`Migration target revision is missing for ${relativePath}: ${revisionId}`);
    return {
      contents: await context.blobStore.getText(revision.project_blob_key),
      datasetsContents: revision.dataset_blob_key ? await context.blobStore.getText(revision.dataset_blob_key) : null,
    };
  };
  const draft = await readRevision(workflow.current_draft_revision_id);
  const published = workflow.published_revision_id ? await readRevision(workflow.published_revision_id) : null;
  return {
    workflowId: workflow.workflow_id,
    relativePath: workflow.relative_path,
    name: workflow.name,
    fileName: workflow.file_name,
    updatedAt: toIsoString(workflow.updated_at)!,
    ...draft,
    endpointName: workflow.endpoint_name,
    endpointAccess: workflow.endpoint_access,
    publicationVersion: workflow.publication_version,
    publishedEndpointName: workflow.published_endpoint_name,
    publishedVersionId: workflow.published_version_id,
    publishedContents: published?.contents ?? null,
    publishedDatasetsContents: published?.datasetsContents ?? null,
    lastPublishedAt: toIsoString(workflow.last_published_at),
    publishedVersions: await Promise.all(
      versionRows.rows.map(async (version) => ({
        versionId: version.version_id,
        endpointName: version.endpoint_name,
        publishedAt: toIsoString(version.published_at)!,
        isStarred: version.is_starred,
        comment: version.comment,
        ...(await readRevision(version.revision_id)),
      })),
    ),
    publishedWebApps: await Promise.all(
      webAppRows.rows.map(async (webApp) => ({
        appId: webApp.app_id,
        uiGraphId: webApp.ui_graph_id,
        slug: webApp.slug,
        allowedEmails: webApp.allowed_emails,
        publishedAt: toIsoString(webApp.published_at)!,
        ...(await readRevision(webApp.revision_id)),
      })),
    ),
  };
}
