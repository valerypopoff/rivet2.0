import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import {
  deserializeDatasets,
  loadProjectAndAttachedDataFromString,
  remapOwnedDatasets,
  serializeDatasets,
  type ProjectId,
} from '@valerypopoff/rivet2-node';
import { conflict } from '../../../utils/httpError.js';
import type { StructuralMutation } from '../../../../../studio-server-shared/workflow-mutation-contract.js';
import type { ManagedWorkflowContext } from './context.js';
import type { RevisionRow } from './types.js';
import { previousStructuralResult, structuralTransaction } from './structural-admission.js';
import { captureOperation } from './namespace-receipts.js';
import { createPreparedRevisions } from './prepared-revisions.js';

export const datasetOwnershipHash = (text: string) => createHash('sha256').update(text).digest('hex');

/** Bounded, observational page over current drafts and currently served snapshots.
 * Never prints dataset/project bytes or creates a maintenance owner. */
export async function auditManagedDatasetOwnership(
  dependencies: { pool: Pool; readRevisionContents: ManagedWorkflowContext['revisions']['readRevisionContents'] },
  options: { after?: string; limit?: number } = {},
) {
  const limit = options.limit ?? 50;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100 || (options.after?.length ?? 0) > 256)
    throw new Error('Audit requires a page size from 1 to 100 and a bounded revision cursor.');
  const rows = (
    await dependencies.pool.query<RevisionRow & { is_draft: boolean }>(
      `
    SELECT r.*, (w.current_draft_revision_id=r.revision_id) AS is_draft
    FROM workflow_revisions r JOIN workflows w ON w.workflow_id=r.workflow_id
    WHERE r.revision_id > $1 AND (w.current_draft_revision_id=r.revision_id OR w.published_revision_id=r.revision_id
      OR EXISTS(SELECT 1 FROM workflow_web_apps app WHERE app.workflow_id=w.workflow_id AND app.revision_id=r.revision_id))
    ORDER BY r.revision_id LIMIT $2`,
      [options.after ?? '', limit + 1],
    )
  ).rows;
  const findings = [];
  for (const row of rows.slice(0, limit)) {
    if (!row.dataset_blob_key) continue;
    try {
      const bytes = await dependencies.readRevisionContents(row);
      const [project] = loadProjectAndAttachedDataFromString(bytes.contents);
      if (project.metadata.id !== row.workflow_id) throw new Error('Project identity mismatch');
      const datasets = deserializeDatasets(bytes.datasetsContents!);
      const mismatches = datasets.filter((dataset) => dataset.meta.projectId !== row.workflow_id).length;
      if (mismatches)
        findings.push({
          projectId: row.workflow_id,
          revisionId: row.revision_id,
          isDraft: row.is_draft,
          problem: 'owner-mismatch',
          mismatchedDatasets: mismatches,
          datasetKey: row.dataset_blob_key,
          datasetHash: datasetOwnershipHash(bytes.datasetsContents!),
          projectKey: row.project_blob_key,
          projectHash: datasetOwnershipHash(bytes.contents),
        });
    } catch {
      findings.push({
        projectId: row.workflow_id,
        revisionId: row.revision_id,
        isDraft: row.is_draft,
        problem: 'unreadable-artifact',
      });
    }
  }
  return {
    checkedRevisions: Math.min(limit, rows.length),
    findings,
    nextCursor: rows.length > limit ? rows[limit - 1]!.revision_id : null,
  };
}

export type DatasetOwnershipRepair = {
  projectId: string;
  expectedRevisionId: string;
  expectedProjectHash: string;
  expectedDatasetKey: string;
  expectedDatasetHash: string;
  /** A reviewed immutable source snapshot must contain the exact inherited sidecar. */
  sourceProjectId: string;
  sourceRevisionId: string;
  sourceDatasetKey: string;
  approvalReason: string;
  mutation: StructuralMutation;
};

/** Internal, explicit repair primitive. No HTTP route or automatic migration.
 * Writes a new draft only; published/history revisions are never rewritten. */
export async function repairManagedDatasetOwnership(context: ManagedWorkflowContext, request: DatasetOwnershipRepair) {
  const captured = captureOperation(
    request,
    (input) => input.mutation,
    (input) => ({ operation: 'repair-dataset-ownership', input }),
  );
  request = captured.input;
  type Result = { projectId: string; revisionId: string };
  const previous = await previousStructuralResult<Result>(context, captured.admission);
  if (previous.state === 'committed') return previous.result;
  if (
    !request.approvalReason.trim() ||
    request.approvalReason.length > 512 ||
    request.sourceProjectId === request.projectId
  )
    throw conflict('Repair requires explicit reviewed provenance from a different source project.');
  if (
    request.mutation.expectedSource?.id !== request.projectId ||
    request.mutation.expectedSource.revisionId !== request.expectedRevisionId
  )
    throw conflict('Repair admission must bind the explicitly reviewed project and draft revision.');
  const observed = await context.queries.getWorkflowById(context.pool, request.projectId);
  const target = await context.queries.getRevision(context.pool, request.expectedRevisionId);
  const source = await context.queries.getRevision(context.pool, request.sourceRevisionId);
  if (
    !observed ||
    observed.current_draft_revision_id !== request.expectedRevisionId ||
    target?.workflow_id !== request.projectId ||
    target.dataset_blob_key !== request.expectedDatasetKey ||
    source?.workflow_id !== request.sourceProjectId ||
    source.dataset_blob_key !== request.sourceDatasetKey
  )
    throw conflict('Repair identity, draft revision or provenance changed. Review again.');
  const targetData = await context.revisions.readRevisionContents(target);
  const sourceData = await context.revisions.readRevisionContents(source);
  if (
    datasetOwnershipHash(targetData.contents) !== request.expectedProjectHash ||
    targetData.datasetsContents === null ||
    targetData.datasetsContents !== sourceData.datasetsContents ||
    datasetOwnershipHash(targetData.datasetsContents) !== request.expectedDatasetHash
  )
    throw conflict('The sidecar does not match the reviewed source artifact.');
  const [project] = loadProjectAndAttachedDataFromString(targetData.contents);
  const [sourceProject] = loadProjectAndAttachedDataFromString(sourceData.contents);
  if (project.metadata.id !== request.projectId || sourceProject.metadata.id !== request.sourceProjectId)
    throw conflict('Saved project identity differs from its recorded owner.');
  const datasets = remapOwnedDatasets(
    deserializeDatasets(targetData.datasetsContents),
    request.sourceProjectId as ProjectId,
    request.projectId as ProjectId,
  );
  if (!datasets.length) throw conflict('No inherited datasets require repair.');
  const preparations = createPreparedRevisions(context.revisions, captured.admission);
  try {
    const prepared = await preparations.prepare(request.projectId, targetData.contents, serializeDatasets(datasets));
    const result = await structuralTransaction(
      context,
      captured.admission,
      async (client, hooks) => {
        const current = await context.queries.getWorkflowById(client, request.projectId, { forUpdate: true });
        const currentSource = await context.queries.getRevision(client, request.sourceRevisionId);
        const currentTarget = await context.queries.getRevision(client, request.expectedRevisionId);
        if (
          JSON.stringify(current) !== JSON.stringify(observed) ||
          JSON.stringify(currentSource) !== JSON.stringify(source) ||
          JSON.stringify(currentTarget) !== JSON.stringify(target)
        )
          throw conflict('Repair authority changed during preparation. Review again.');
        await context.revisions.insertRevision(client, prepared);
        preparations.stage(prepared, hooks);
        await client.query('UPDATE workflows SET current_draft_revision_id=$2,updated_at=NOW() WHERE workflow_id=$1', [
          request.projectId,
          prepared.revision_id,
        ]);
        await context.executionInvalidationController.queueWorkflowInvalidation(client, hooks, request.projectId);
        return { projectId: request.projectId, revisionId: prepared.revision_id };
      },
      preparations,
    );
    return result;
  } finally {
    await preparations.close();
  }
}
