import type { Pool } from 'pg';
import type { SubgraphProjectTarget } from '@valerypopoff/rivet2-node';
import { createHttpError } from '../../../utils/httpError.js';

/** Live hierarchy, one SQL snapshot; never infer access from authored hints or cached project bytes. */
export async function validateManagedSubgraphTarget(pool: Pool, target: SubgraphProjectTarget): Promise<void> {
  const result = await pool.query<{ bundle_id: string | null; caller_bundle_id: string | null }>(
    `
    SELECT target_bundle.bundle_id, caller_bundle.bundle_id AS caller_bundle_id
    FROM workflows target
    LEFT JOIN workflows caller ON caller.workflow_id=$2
    LEFT JOIN LATERAL (
      SELECT bundle_id FROM workflow_folders WHERE bundle_id IS NOT NULL AND
      (relative_path=target.folder_relative_path OR left(target.folder_relative_path,length(relative_path)+1)=relative_path || '/')
      LIMIT 1
    ) target_bundle ON true
    LEFT JOIN LATERAL (
      SELECT bundle_id FROM workflow_folders WHERE bundle_id IS NOT NULL AND
      (relative_path=caller.folder_relative_path OR left(caller.folder_relative_path,length(relative_path)+1)=relative_path || '/')
      LIMIT 1
    ) caller_bundle ON true
    WHERE target.workflow_id=$1`,
    [target.projectId, target.callerProjectId ?? null],
  );
  const row = result.rows[0];
  if (!row) throw createHttpError(404, 'Subgraph target project was not found.');
  if (row.bundle_id && row.bundle_id !== row.caller_bundle_id)
    throw createHttpError(
      403,
      'This project belongs to a bundle. Only projects in the same bundle can reference it through a Subgraph node.',
      { code: 'subgraph_bundle_scope_forbidden' },
    );
}
