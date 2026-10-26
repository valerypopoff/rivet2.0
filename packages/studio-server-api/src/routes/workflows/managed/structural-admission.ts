import type { PoolClient } from 'pg';
import type { StructuralMutation } from '../../../../../studio-server-shared/workflow-mutation-contract.js';
import { conflict, createHttpError } from '../../../utils/httpError.js';
import type { ManagedWorkflowContext } from './context.js';
import {
  assertMutationAdmission,
  recoverCapturedReceipt,
  withMutationReceipt,
  type CapturedReceipt,
} from './namespace-receipts.js';
import { lockBundleTopology } from './topology-lock.js';
import type { TransactionHooks } from './types.js';
import type { PreparedRevisions } from './prepared-revisions.js';

export type CatalogTransaction = { client: PoolClient; hooks: TransactionHooks; readonly topologyOwned: true };

/** One explicit owner for standalone internal catalog operations too. */
export function withCatalogTransaction<T>(
  context: Pick<ManagedWorkflowContext, 'withTransaction'>,
  run: (tx: CatalogTransaction) => Promise<T>,
) {
  return context.withTransaction(async (client, hooks) => {
    await lockBundleTopology(client);
    return run({ client, hooks, topologyOwned: true });
  });
}

export async function folderIdentity(
  client: ManagedWorkflowContext['pool'] | PoolClient,
  path: string,
): Promise<string | null> {
  if (!path) return null;
  const row = (
    await client.query<{ namespace_id: string }>('SELECT namespace_id FROM workflow_folders WHERE relative_path=$1', [
      path,
    ])
  ).rows[0];
  if (!row) throw createHttpError(404, 'Destination folder not found.');
  return row.namespace_id;
}

export async function assertFolderIdentity(
  client: ManagedWorkflowContext['pool'] | PoolClient,
  path: string,
  expected: string | null | undefined,
) {
  if (expected === undefined || (await folderIdentity(client, path)) !== expected)
    throw conflict('The destination folder changed. Refresh the library before trying again.');
}

export async function assertSaveAsDestination(
  client: ManagedWorkflowContext['pool'] | PoolClient,
  parent: string,
  mutation: StructuralMutation,
) {
  const anchor = mutation.expectedDestinationPath;
  if (anchor === undefined || (anchor !== '' && parent !== anchor && !parent.startsWith(anchor + '/')))
    throw conflict('Refresh the Save As destination before trying again.');
  await assertFolderIdentity(client, anchor, mutation.expectedDestinationId);
  const segments = parent.split('/').filter(Boolean);
  const missing = segments
    .map((_, index) => segments.slice(0, index + 1).join('/'))
    .filter((path) => anchor === '' || path.length > anchor.length);
  if (
    missing.length &&
    (await client.query('SELECT 1 FROM workflow_folders WHERE relative_path=ANY($1::text[]) LIMIT 1', [missing]))
      .rowCount
  )
    throw conflict('The Save As folder chain changed. Refresh before trying again.');
}

export async function previousStructuralResult<T>(
  context: ManagedWorkflowContext,
  admission: CapturedReceipt | undefined,
) {
  await context.initialize();
  if (!admission) return { state: 'unknown' as const };
  const previous = await recoverCapturedReceipt<T>(context.pool, admission);
  if (previous.state !== 'committed') assertMutationAdmission(admission);
  return previous;
}

export function structuralTransaction<T>(
  context: ManagedWorkflowContext,
  admission: CapturedReceipt | undefined,
  run: (client: PoolClient, hooks: TransactionHooks) => Promise<T>,
  preparations?: PreparedRevisions,
): Promise<T> {
  return withCatalogTransaction(context, (tx) => {
    preparations?.observe(tx.hooks);
    return withMutationReceipt(tx, admission, () => run(tx.client, tx.hooks));
  });
}
