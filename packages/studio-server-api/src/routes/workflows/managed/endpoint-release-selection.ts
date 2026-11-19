import type { EndpointReleaseSelector } from './endpoint-release-manifest.js';
import type { ManagedWorkflowDbClient } from './db.js';

export type EndpointDependencyPointer = {
  workflow_id: string;
  name: string;
  relative_path: string;
  current_draft_revision_id: string;
  published_revision_id: string | null;
  bundle_id: string | null;
  bundle_relative_path: string | null;
};

export async function readDependencyPointers(
  client: ManagedWorkflowDbClient,
  ids: readonly string[],
  lock = false,
): Promise<Map<string, EndpointDependencyPointer>> {
  const rows = await client.query<EndpointDependencyPointer>(
    `
    SELECT w.workflow_id, w.name, w.relative_path, w.current_draft_revision_id,
           w.published_revision_id, b.bundle_id, b.relative_path AS bundle_relative_path
    FROM workflows w
    LEFT JOIN LATERAL (
      SELECT bundle_id, relative_path FROM workflow_folders f
      WHERE f.bundle_id IS NOT NULL AND
      (f.relative_path = w.folder_relative_path OR left(w.folder_relative_path, length(f.relative_path)+1) = f.relative_path || '/')
      LIMIT 1
    ) b ON true
    WHERE w.workflow_id = ANY($1::text[])
    ORDER BY w.workflow_id
    ${lock ? 'FOR UPDATE OF w' : ''}
  `,
    [ids],
  );
  return new Map(rows.rows.map((row) => [row.workflow_id, row]));
}

export function selectDependencyRevision(
  pointer: EndpointDependencyPointer | undefined,
  selector: EndpointReleaseSelector,
) {
  if (!pointer) return null;
  if (selector === 'published') return pointer.published_revision_id;
  if (selector === 'project-reference') return pointer.published_revision_id ?? pointer.current_draft_revision_id;
  return pointer.current_draft_revision_id;
}
